import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyWebhookOptions {
  tolerance?: number;
}

const DIGITS_ONLY = /^\d+$/;
const HEX_REGEX = /^[0-9a-f]{64}$/;

export const verifyWebhookSignature = (
  payload: string,
  signature: string,
  timestamp: string,
  secret: string,
  options?: VerifyWebhookOptions
): boolean => {
  const tolerance = options?.tolerance ?? 300;

  // Validate timestamp is a positive integer (not float, not scientific notation)
  if (!DIGITS_ONLY.test(timestamp)) {
    return false;
  }

  const timestampNum = Number(timestamp);
  if (!Number.isFinite(timestampNum) || timestampNum <= 0) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNum) > tolerance) {
    return false;
  }

  const message = `${timestamp}.${payload}`;
  const expected = createHmac("sha256", secret).update(message).digest("hex");

  const provided = signature.startsWith("sha256=")
    ? signature.slice(7)
    : signature;

  // Validate provided signature is valid lowercase hex of correct length
  // This prevents Buffer.from silently dropping non-hex characters
  if (!HEX_REGEX.test(provided)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
};
