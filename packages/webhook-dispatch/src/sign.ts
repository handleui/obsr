const encoder = new TextEncoder();

export const importSigningKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

export const signPayload = async (
  secret: string | CryptoKey,
  timestamp: number,
  body: string
): Promise<string> => {
  const key =
    typeof secret === "string" ? await importSigningKey(secret) : secret;
  const message = `${timestamp}.${body}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message)
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
