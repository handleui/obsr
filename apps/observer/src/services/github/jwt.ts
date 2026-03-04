import type { GitHubServiceConfig } from "./types";

const PEM_BEGIN_RSA = /-----BEGIN RSA PRIVATE KEY-----/;
const PEM_END_RSA = /-----END RSA PRIVATE KEY-----/;
const PEM_BEGIN_PKCS8 = /-----BEGIN PRIVATE KEY-----/;
const PEM_END_PKCS8 = /-----END PRIVATE KEY-----/;
const WHITESPACE = /\s/g;
const BASE64_TRAILING_EQUALS = /=+$/;

const pemToArrayBuffer = (pem: string): ArrayBuffer => {
  const base64 = pem
    .replace(PEM_BEGIN_RSA, "")
    .replace(PEM_END_RSA, "")
    .replace(PEM_BEGIN_PKCS8, "")
    .replace(PEM_END_PKCS8, "")
    .replace(WHITESPACE, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

const base64UrlEncode = (data: ArrayBuffer | string): string => {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const binary = Array.from(new Uint8Array(bytes))
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(BASE64_TRAILING_EQUALS, "");
};

export const generateAppJwt = async (
  config: GitHubServiceConfig
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: config.appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const keyData = pemToArrayBuffer(config.privateKey);

  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    throw new Error(
      "Failed to import private key. Ensure it's in PKCS#8 format. " +
        "Convert with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem"
    );
  }

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
};
