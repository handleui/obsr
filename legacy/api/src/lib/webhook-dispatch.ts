import {
  importSigningKey,
  signPayload,
  type WebhookEventType,
  type WebhookPayload,
} from "@obsr/webhook-dispatch";
import type { ObserverClient } from "../db/client";
import { decryptToken } from "./encryption";

type WebhookResolveData = WebhookPayload["data"];

interface WebhookRecord {
  _id: string;
  url: string;
  events: string[];
  secretEncrypted: string;
  active: boolean;
}

// Workers waitUntil budget is ~30s. With 5s fetch timeout per attempt:
// 4 attempts (5s each) + delays (0.5s + 1s + 2s) = 23.5s worst case.
const RETRY_DELAYS = [500, 1000, 2000];
const FETCH_TIMEOUT_MS = 5000;

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

const truncatePatch = (data: WebhookResolveData): WebhookResolveData => {
  if (!data.patch) {
    return data;
  }
  // Rough byte estimate: 1 char ~ 1 byte for ASCII diffs, leave room for envelope
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
  dbClient: ObserverClient,
  encryptionKey: string,
  organizationId: string,
  event: WebhookEventType,
  resolveData: WebhookResolveData
): Promise<void> => {
  try {
    const webhooks = (await dbClient.query("webhooks:listActiveByOrg", {
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
      data: truncatePatch(resolveData),
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
