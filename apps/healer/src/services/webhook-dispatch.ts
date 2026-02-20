import {
  importSigningKey,
  signPayload,
  type WebhookEventType,
  type WebhookHealData,
  type WebhookPayload,
} from "@detent/webhook-dispatch";
import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

const asQuery = (name: string) => name as unknown as FunctionReference<"query">;

const base64ToBuffer = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

// Cache imported AES decryption keys by base64 string.
// The encryption key is the same across all webhooks in a dispatch,
// so we avoid calling crypto.subtle.importKey N times.
let cachedAesKeyBase64: string | null = null;
let cachedAesKey: CryptoKey | null = null;

const importAesKey = async (keyBase64: string): Promise<CryptoKey> => {
  if (cachedAesKeyBase64 === keyBase64 && cachedAesKey) {
    return cachedAesKey;
  }
  const keyBuffer = base64ToBuffer(keyBase64);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuffer.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  cachedAesKeyBase64 = keyBase64;
  cachedAesKey = key;
  return key;
};

const decryptToken = async (
  encrypted: string,
  keyBase64: string
): Promise<string> => {
  const parts = encrypted.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid encrypted token format");
  }
  const iv = base64ToBuffer(parts[0]);
  const ciphertext = base64ToBuffer(parts[1]);
  const key = await importAesKey(keyBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer
  );
  return new TextDecoder().decode(decrypted);
};

interface WebhookRecord {
  _id: string;
  url: string;
  events: string[];
  secretEncrypted: string;
  active: boolean;
}

// Healer runs on Node.js (Railway) with no waitUntil budget constraint.
// Keep original retry delays for better delivery reliability.
const RETRY_DELAYS = [1000, 3000, 10_000];
const FETCH_TIMEOUT_MS = 10_000;

// Max webhook payload body size (256 KB)
const MAX_PAYLOAD_BYTES = 256 * 1024;

const deliverWebhook = async (
  url: string,
  body: string,
  signingKey: CryptoKey,
  event: string,
  deliveryId: string
): Promise<boolean> => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signPayload(signingKey, timestamp, body);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Detent-Webhooks/1.0",
      "X-Detent-Event": event,
      "X-Detent-Delivery": deliveryId,
      "X-Detent-Timestamp": String(timestamp),
      "X-Detent-Signature": `sha256=${signature}`,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return response.ok;
};

const deliverWithRetries = async (
  url: string,
  body: string,
  signingKey: CryptoKey,
  event: string,
  deliveryId: string
): Promise<void> => {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const ok = await deliverWebhook(url, body, signingKey, event, deliveryId);
      if (ok) {
        return;
      }
    } catch {
      // Retry on network/timeout errors
    }
    if (attempt < RETRY_DELAYS.length) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS[attempt])
      );
    }
  }
  const safeUrl = (() => {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return "<invalid-url>";
    }
  })();
  console.error(
    `[webhook] Failed to deliver to ${safeUrl} after ${RETRY_DELAYS.length + 1} attempts`
  );
};

const truncatePatch = (data: WebhookHealData): WebhookHealData => {
  if (!data.patch) {
    return data;
  }
  const maxPatchChars = MAX_PAYLOAD_BYTES - 4096;
  if (data.patch.length <= maxPatchChars) {
    return data;
  }
  return {
    ...data,
    patch: `${data.patch.slice(0, maxPatchChars)}\n... [truncated — patch exceeded ${MAX_PAYLOAD_BYTES} byte limit]`,
  };
};

export const dispatchWebhookEvent = async (
  convex: ConvexClient,
  encryptionKey: string,
  organizationId: string,
  event: WebhookEventType,
  healData: WebhookHealData
): Promise<void> => {
  try {
    const webhooks = (await convex.query(asQuery("webhooks:listActiveByOrg"), {
      organizationId,
    })) as WebhookRecord[];
    if (!webhooks || webhooks.length === 0) {
      return;
    }
    const matching = webhooks.filter((w) => w.events.includes(event));
    if (matching.length === 0) {
      return;
    }

    const payload: WebhookPayload = {
      id: crypto.randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      organization_id: organizationId,
      data: truncatePatch(healData),
    };

    // Stringify once, reuse across all webhooks and retries
    const body = JSON.stringify(payload);

    await Promise.allSettled(
      matching.map(async (webhook) => {
        try {
          const secret = await decryptToken(
            webhook.secretEncrypted,
            encryptionKey
          );
          const signingKey = await importSigningKey(secret);
          await deliverWithRetries(
            webhook.url,
            body,
            signingKey,
            payload.event,
            payload.id
          );
        } catch (error) {
          console.error(
            `[webhook] Dispatch error for webhook ${webhook._id}:`,
            error instanceof Error ? error.message : "Unknown error"
          );
        }
      })
    );
  } catch (error) {
    console.error(
      "[webhook] Failed to dispatch webhook event:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
};
