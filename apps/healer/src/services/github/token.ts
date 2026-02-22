import type { Env } from "../../env.js";

export const GITHUB_API = "https://api.github.com";
const PEM_BEGIN_RSA = /-----BEGIN RSA PRIVATE KEY-----/;
const PEM_END_RSA = /-----END RSA PRIVATE KEY-----/;
const PEM_BEGIN_PKCS8 = /-----BEGIN PRIVATE KEY-----/;
const PEM_END_PKCS8 = /-----END PRIVATE KEY-----/;
const WHITESPACE = /\s/g;
const BASE64_TRAILING_EQUALS = /=+$/;

interface TokenCache {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, TokenCache>();

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

const generateAppJwt = async (
  appId: string,
  privateKey: string
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const keyData = pemToArrayBuffer(privateKey);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
};

export const getInstallationToken = async (
  env: Env,
  installationId: number
): Promise<string> => {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const privateKey = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  const jwt = await generateAppJwt(env.GITHUB_APP_ID, privateKey);

  const response = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Detent-Healer",
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Failed to get installation token: ${response.status} ${error}`
    );
  }

  const data = (await response.json()) as { token: string; expires_at: string };

  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  });

  console.log(
    `[github] Got installation token for ${installationId} (expires: ${data.expires_at})`
  );

  return data.token;
};
