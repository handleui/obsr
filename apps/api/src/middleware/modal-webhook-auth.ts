/**
 * Modal webhook authentication middleware
 *
 * Verifies Modal executor webhook requests using HMAC signature verification.
 * Similar pattern to GitHub webhook signature middleware.
 */

import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../types/env";

declare module "hono" {
  interface ContextVariableMap {
    modalWebhookPayload: unknown;
  }
}

const timingSafeEqual = (a: string, b: string): boolean => {
  const maxLen = Math.max(a.length, b.length);
  const paddedA = a.padEnd(maxLen, "\0");
  const paddedB = b.padEnd(maxLen, "\0");

  // biome-ignore lint/suspicious/noBitwiseOperators: XOR required for constant-time comparison
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: XOR and OR required for constant-time comparison
    result |= paddedA.charCodeAt(i) ^ paddedB.charCodeAt(i);
  }

  return result === 0;
};

export const modalWebhookAuthMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<void> => {
  const signature = c.req.header("X-Modal-Signature");
  const secret = c.env.MODAL_WEBHOOK_SECRET;

  if (!signature) {
    throw new HTTPException(401, {
      message: "Missing X-Modal-Signature header",
    });
  }

  if (!secret) {
    console.error("[modal-webhook-auth] MODAL_WEBHOOK_SECRET not configured");
    throw new HTTPException(500, { message: "Internal server error" });
  }

  const rawBody = await c.req.text();

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rawBody)
  );

  const expectedSignature =
    "sha256=" +
    Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  if (!timingSafeEqual(expectedSignature, signature)) {
    throw new HTTPException(401, { message: "Invalid webhook signature" });
  }

  c.set("modalWebhookPayload", JSON.parse(rawBody));

  await next();
};
