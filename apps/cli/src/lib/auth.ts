/**
 * Better Auth Device Authorization Flow for CLI authentication
 *
 * Implements OAuth 2.0 Device Authorization Grant (RFC 8628)
 * for authenticating CLI users through their browser.
 */

import { decodeJwt } from "jose";
import type { Credentials } from "./credentials.js";
import {
  isTokenExpired,
  loadCredentials,
  saveCredentials,
} from "./credentials.js";

const getApiUrl = (): string => {
  return process.env.DETENT_API_URL ?? "https://observer.detent.sh";
};

const getDeviceClientId = (): string => {
  return process.env.DETENT_CLI_CLIENT_ID ?? "detent-cli";
};

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  github_token?: string;
  github_token_expires_at?: number;
  github_refresh_token?: string;
  github_refresh_token_expires_at?: number;
}

export interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

export interface UserInfo {
  sub: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  org_id?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const requestDeviceAuthorization =
  async (): Promise<DeviceAuthorizationResponse> => {
    const response = await fetch(`${getApiUrl()}/api/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: getDeviceClientId(),
        scope: "openid profile email",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to request device authorization: ${error}`);
    }

    return response.json() as Promise<DeviceAuthorizationResponse>;
  };

const MAX_POLL_ATTEMPTS = 120;

export const pollForTokens = async (
  deviceCode: string,
  interval: number,
  onPoll?: () => void
): Promise<TokenResponse> => {
  let pollInterval = interval;
  let attempts = 0;

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    await sleep(pollInterval * 1000);
    onPoll?.();

    const response = await fetch(`${getApiUrl()}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: getDeviceClientId(),
      }),
    });

    const data = (await response.json()) as TokenResponse | TokenErrorResponse;

    if ("error" in data) {
      if (data.error === "authorization_pending") {
        continue;
      }
      if (data.error === "slow_down") {
        pollInterval += 5;
        continue;
      }
      if (data.error === "expired_token") {
        throw new Error("Device code expired. Please try logging in again.");
      }
      if (data.error === "access_denied") {
        throw new Error("Authorization was denied.");
      }
      throw new Error(data.error_description ?? data.error);
    }

    return data;
  }

  throw new Error(
    "Authentication timed out. Please try again with `dt auth login`."
  );
};

export const getJwtExpiration = (token: string): number => {
  const payload = decodeJwt(token);
  if (typeof payload.exp === "number") {
    return payload.exp * 1000;
  }
  return Date.now() + 3600 * 1000;
};

export const getAccessToken = (): string => {
  const credentials = loadCredentials();

  if (!credentials) {
    throw new Error("Not logged in. Run `dt auth login` first.");
  }

  if (!isTokenExpired(credentials)) {
    return credentials.access_token;
  }

  throw new Error(
    "Session expired. Run `dt auth login --force` to re-authenticate."
  );
};

export const decodeUserInfo = (accessToken: string): UserInfo => {
  const payload = decodeJwt(accessToken);
  return {
    sub: payload.sub as string,
    email: payload.email as string | undefined,
    first_name: payload.first_name as string | undefined,
    last_name: payload.last_name as string | undefined,
    org_id: payload.org_id as string | undefined,
  };
};

export const getExpiresAt = (accessToken: string): Date | null => {
  const payload = decodeJwt(accessToken);
  if (typeof payload.exp === "number") {
    return new Date(payload.exp * 1000);
  }
  return null;
};

export const isGitHubTokenExpired = (credentials: Credentials): boolean => {
  if (!credentials.github_token) {
    return true;
  }
  if (!credentials.github_token_expires_at) {
    return false;
  }
  const bufferMs = 5 * 60 * 1000;
  return credentials.github_token_expires_at < Date.now() + bufferMs;
};

export const isGitHubRefreshTokenExpired = (
  credentials: Credentials
): boolean => {
  if (
    !(
      credentials.github_refresh_token &&
      credentials.github_refresh_token_expires_at
    )
  ) {
    return true;
  }
  const bufferMs = 60 * 60 * 1000;
  return credentials.github_refresh_token_expires_at < Date.now() + bufferMs;
};

const refreshGitHubTokenInternal = async (
  accessToken: string,
  credentials: Credentials
): Promise<Credentials | null> => {
  if (
    !(
      credentials.github_refresh_token &&
      !isGitHubRefreshTokenExpired(credentials)
    )
  ) {
    return null;
  }

  try {
    const { refreshGitHubToken } = await import("./api.js");
    const response = await refreshGitHubToken(
      accessToken,
      credentials.github_refresh_token
    );

    const newCredentials: Credentials = {
      ...credentials,
      github_token: response.access_token,
      github_token_expires_at: response.access_token_expires_at,
      github_refresh_token: response.refresh_token,
      github_refresh_token_expires_at: response.refresh_token_expires_at,
    };

    saveCredentials(newCredentials);
    return newCredentials;
  } catch {
    return null;
  }
};

export const getGitHubToken = async (): Promise<string | null> => {
  const credentials = loadCredentials();
  if (!credentials?.github_token) {
    return null;
  }

  if (!isGitHubTokenExpired(credentials)) {
    return credentials.github_token;
  }

  if (
    credentials.github_refresh_token &&
    !isGitHubRefreshTokenExpired(credentials)
  ) {
    try {
      const accessToken = await getAccessToken();
      const newCredentials = await refreshGitHubTokenInternal(
        accessToken,
        credentials
      );
      if (newCredentials?.github_token) {
        return newCredentials.github_token;
      }
    } catch {
      return null;
    }
  }

  return null;
};

export interface TokenHealthStatus {
  access: "valid" | "expired" | "missing";
  github: "valid" | "expired" | "refresh_available" | "missing";
}

export const checkTokenHealth = (): TokenHealthStatus => {
  const credentials = loadCredentials();

  if (!credentials) {
    return { access: "missing", github: "missing" };
  }

  const accessStatus: TokenHealthStatus["access"] = isTokenExpired(credentials)
    ? "expired"
    : "valid";

  let githubStatus: TokenHealthStatus["github"] = "missing";
  if (credentials.github_token) {
    if (!isGitHubTokenExpired(credentials)) {
      githubStatus = "valid";
    } else if (
      credentials.github_refresh_token &&
      !isGitHubRefreshTokenExpired(credentials)
    ) {
      githubStatus = "refresh_available";
    } else {
      githubStatus = "expired";
    }
  }

  return { access: accessStatus, github: githubStatus };
};

export const authenticateViaWeb = async (): Promise<TokenResponse> => {
  const { openBrowser } = await import("./browser.js");

  const device = await requestDeviceAuthorization();

  try {
    await openBrowser(device.verification_uri_complete);
  } catch {
    console.log(
      `\nPlease open this URL in your browser:\n  ${device.verification_uri_complete}\n`
    );
  }

  return pollForTokens(device.device_code, device.interval);
};
