/**
 * Generate a secure random token for invitation links
 * Uses 32 bytes (256 bits) of randomness, base64url encoded
 */
export const generateSecureToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  // Base64url encode (URL-safe, no padding)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

/**
 * Generate a secure API key with "dtk_" prefix
 * Uses 24 bytes (192 bits) of randomness, base64url encoded
 */
export const generateApiKey = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // Base64url encode (URL-safe, no padding)
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `dtk_${encoded}`;
};

/**
 * Hash an API key using SHA-256 for secure storage
 * API keys are high-entropy, so a fast hash is sufficient (no need for bcrypt/argon2)
 */
export const hashApiKey = async (key: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Timing-safe string comparison to prevent timing attacks
 * Used for comparing API keys, hashes, and other secrets
 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  // Pad to same length to avoid length-based timing leak
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
