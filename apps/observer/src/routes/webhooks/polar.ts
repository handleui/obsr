import type { ConvexHttpClient } from "convex/browser";
import { Hono } from "hono";
import { getConvexClient } from "../../db/convex";
import type { Env } from "../../types/env";

// ============================================================================
// Constants
// ============================================================================

const LOG_PREFIX = "[polar-webhook]";

// Events that require database access
const DB_REQUIRED_EVENTS = new Set([
  "customer.created",
  "order.paid",
  "subscription.active",
  "subscription.canceled",
  "subscription.revoked",
]);

// Standard Webhooks tolerance: 5 minutes
const TIMESTAMP_TOLERANCE_SECONDS = 300;

// ============================================================================
// Types
// ============================================================================

interface PolarWebhookEvent {
  type: string;
  data: {
    id?: string;
    externalId?: string;
    [key: string]: unknown;
  };
}

interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

// ============================================================================
// Signature Verification (Standard Webhooks Spec)
// ============================================================================
//
// NOTE: We implement signature verification manually instead of using the SDK's
// `validateEvent` from `@polar-sh/sdk/webhooks` because the SDK uses Node.js
// `Buffer` API which is not available in Cloudflare Workers. This implementation
// uses Web Crypto API (`crypto.subtle`) which is Worker-compatible.
// See: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md

// Extract the raw secret from whsec_ prefixed secret
const extractSecret = (secret: string): string => {
  if (secret.startsWith("whsec_")) {
    return secret.slice(6);
  }
  return secret;
};

// Timing-safe string comparison
const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: XOR + OR for timing-safe comparison
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

// Verify Standard Webhooks signature
// Spec: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
const verifyWebhookSignature = async (
  payload: string,
  headers: WebhookHeaders,
  secret: string
): Promise<boolean> => {
  const { id, timestamp, signature } = headers;

  // All headers required
  if (!(id && timestamp && signature)) {
    return false;
  }

  // Validate timestamp to prevent replay attacks
  const timestampNum = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampNum)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNum) > TIMESTAMP_TOLERANCE_SECONDS) {
    console.warn(
      `${LOG_PREFIX} Timestamp outside tolerance: ${timestampNum} vs ${now}`
    );
    return false;
  }

  // Standard Webhooks signed content: "${webhook-id}.${webhook-timestamp}.${payload}"
  const signedContent = `${id}.${timestamp}.${payload}`;

  // Extract raw secret (remove whsec_ prefix if present)
  const rawSecret = extractSecret(secret);

  // Decode base64 secret
  let secretBytes: Uint8Array;
  try {
    secretBytes = Uint8Array.from(atob(rawSecret), (c) => c.charCodeAt(0));
  } catch {
    // If not base64, use as-is (for backwards compatibility)
    secretBytes = new TextEncoder().encode(rawSecret);
  }

  // Compute HMAC-SHA256
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedContent)
  );

  const expectedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBuffer))
  );

  // Standard Webhooks signature format: "v1,<base64-signature>"
  // May contain multiple signatures separated by spaces
  const signatures = signature.split(" ");
  for (const sig of signatures) {
    const [version, sigValue] = sig.split(",");
    if (
      version === "v1" &&
      sigValue &&
      timingSafeEqual(sigValue, expectedSignature)
    ) {
      return true;
    }
  }

  return false;
};

// ============================================================================
// Validation Helpers
// ============================================================================

const isValidWebhookEvent = (event: unknown): event is PolarWebhookEvent => {
  if (event === null || typeof event !== "object") {
    return false;
  }
  const e = event as Record<string, unknown>;
  if (typeof e.type !== "string") {
    return false;
  }
  if (e.data === null || typeof e.data !== "object") {
    return false;
  }
  return true;
};

const getStringField = (
  data: Record<string, unknown>,
  field: string
): string | undefined => {
  const value = data[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

// ============================================================================
// Event Handlers
// ============================================================================

const handleCustomerCreated = async (
  convex: ConvexHttpClient,
  data: PolarWebhookEvent["data"]
) => {
  const externalId = getStringField(data, "externalId");
  const customerId = getStringField(data, "id");
  if (externalId && customerId) {
    await convex.mutation("organizations:update", {
      id: externalId,
      polarCustomerId: customerId,
      updatedAt: Date.now(),
    });
  }
};

const handleOrderPaid = (data: PolarWebhookEvent["data"]) => {
  const metadata = data.metadata as Record<string, unknown> | undefined;
  const detentOrgId = metadata?.detentOrgId as string | undefined;
  console.log(`${LOG_PREFIX} Order paid for org: ${detentOrgId ?? "unknown"}`);
};

const handleSubscriptionActive = (data: PolarWebhookEvent["data"]) => {
  const customer = data.customer as Record<string, unknown> | undefined;
  const externalId = customer?.externalId as string | undefined;
  console.log(
    `${LOG_PREFIX} Subscription active for: ${externalId ?? "unknown"}`
  );
};

const handleSubscriptionEnded = (
  eventType: string,
  data: PolarWebhookEvent["data"]
) => {
  const customer = data.customer as Record<string, unknown> | undefined;
  const externalId = customer?.externalId as string | undefined;
  console.log(
    `${LOG_PREFIX} Subscription ${eventType} for: ${externalId ?? "unknown"}`
  );
};

const processDbEvent = async (
  convex: ConvexHttpClient,
  event: PolarWebhookEvent
) => {
  switch (event.type) {
    case "customer.created":
      await handleCustomerCreated(convex, event.data);
      break;
    case "order.paid":
      handleOrderPaid(event.data);
      break;
    case "subscription.active":
      handleSubscriptionActive(event.data);
      break;
    case "subscription.canceled":
    case "subscription.revoked":
      handleSubscriptionEnded(event.type, event.data);
      break;
    default:
      break;
  }
};

const processNonDbEvent = (event: PolarWebhookEvent) => {
  switch (event.type) {
    case "subscription.created":
    case "subscription.updated":
      console.log(`${LOG_PREFIX} Subscription event:`, event.type);
      break;
    case "order.created":
      console.log(`${LOG_PREFIX} Order created`);
      break;
    default:
      console.log(`${LOG_PREFIX} Unhandled event type:`, event.type);
  }
};

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const webhookSecret = c.env.POLAR_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error(`${LOG_PREFIX} POLAR_WEBHOOK_SECRET not configured`);
    return c.json({ error: "Webhook not configured" }, 500);
  }

  const payload = await c.req.text();
  const headers: WebhookHeaders = {
    id: c.req.header("webhook-id") ?? null,
    timestamp: c.req.header("webhook-timestamp") ?? null,
    signature: c.req.header("webhook-signature") ?? null,
  };

  const isValid = await verifyWebhookSignature(payload, headers, webhookSecret);
  if (!isValid) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let event: PolarWebhookEvent;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isValidWebhookEvent(parsed)) {
      console.error(`${LOG_PREFIX} Invalid event structure`);
      return c.json({ error: "Invalid event structure" }, 400);
    }
    event = parsed;
  } catch {
    console.error(`${LOG_PREFIX} Failed to parse JSON payload`);
    return c.json({ error: "Invalid JSON" }, 400);
  }

  try {
    if (DB_REQUIRED_EVENTS.has(event.type)) {
      const convex = getConvexClient(c.env);
      await processDbEvent(convex, event);
    } else {
      processNonDbEvent(event);
    }
    return c.json({ received: true });
  } catch (error) {
    console.error(`${LOG_PREFIX} Error processing event:`, error);
    return c.json({ error: "Processing failed" }, 500);
  }
});

export default app;
