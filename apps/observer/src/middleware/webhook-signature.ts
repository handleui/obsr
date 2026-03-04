import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "../lib/crypto";

export const webhookSignatureMiddleware = async (c: Context, next: Next) => {
  const signature = c.req.header("X-Hub-Signature-256");
  const secret = c.env.GITHUB_WEBHOOK_SECRET;

  if (!signature) {
    throw new HTTPException(401, {
      message: "Missing X-Hub-Signature-256 header",
    });
  }

  if (!secret) {
    throw new HTTPException(500, {
      message: "GITHUB_WEBHOOK_SECRET not configured",
    });
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
  const expectedSignature = `sha256=${Array.from(
    new Uint8Array(signatureBuffer)
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  if (!timingSafeEqual(expectedSignature, signature)) {
    throw new HTTPException(401, { message: "Invalid webhook signature" });
  }

  c.set("webhookPayload", JSON.parse(rawBody));

  await next();
};
