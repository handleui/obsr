/**
 * GitHub Secrets Encryption
 *
 * Uses LibSodium sealed boxes to encrypt secrets for GitHub Actions.
 * GitHub provides a public key; we encrypt with it so only GitHub can decrypt.
 *
 * @see https://docs.github.com/en/rest/actions/secrets#create-or-update-an-organization-secret
 */
import sodium from "libsodium-wrappers";

/**
 * Encrypt a secret for GitHub using sealed boxes (crypto_box_seal)
 *
 * @param secret - The plaintext secret to encrypt
 * @param publicKey - Base64-encoded public key from GitHub's API
 * @returns Base64-encoded encrypted secret
 */
export const encryptSecretForGitHub = async (
  secret: string,
  publicKey: string
): Promise<string> => {
  await sodium.ready;

  // Decode GitHub's public key from base64
  const binkey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);

  // Convert secret to bytes
  const binsec = sodium.from_string(secret);

  // Encrypt using sealed box (anonymous sender)
  const encrypted = sodium.crypto_box_seal(binsec, binkey);

  // Return base64-encoded ciphertext
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
};
