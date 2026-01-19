import { seal } from "sealed-box";

/**
 * Decode a base64 string to Uint8Array
 */
const base64ToUint8Array = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

/**
 * Encode a Uint8Array to base64 string
 */
const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  return btoa(String.fromCharCode(...bytes));
};

/**
 * Encrypt a secret for GitHub using sealed boxes (crypto_box_seal)
 *
 * @param secret - The plaintext secret to encrypt
 * @param publicKey - Base64-encoded public key from GitHub's API
 * @returns Base64-encoded encrypted secret
 */
export const encryptSecretForGitHub = (
  secret: string,
  publicKey: string
): string => {
  // Decode GitHub's public key from base64
  const binkey = base64ToUint8Array(publicKey);

  // Convert secret to bytes using TextEncoder
  const binsec = new TextEncoder().encode(secret);

  // Encrypt using sealed box (anonymous sender)
  const encrypted = seal(binsec, binkey);

  // Return base64-encoded ciphertext
  return uint8ArrayToBase64(encrypted);
};
