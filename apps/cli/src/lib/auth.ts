/**
 * WorkOS Device Authorization Flow for CLI authentication
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

const WORKOS_API_BASE = "https://api.workos.com";

const getAuthUrl = (): string => {
  return process.env.DETENT_AUTH_URL ?? "https://navigator.detent.sh";
};

/**
 * Get WorkOS client ID at runtime (not module load time)
 * This ensures dotenv has been loaded before we read the env variable
 */
const getWorkosClientId = (): string => {
  const clientId = process.env.WORKOS_CLIENT_ID ?? "";
  return clientId;
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
  refresh_token: string;
  token_type: string;
  expires_in: number;
  // GitHub OAuth tokens (from Navigator flow when "Return GitHub OAuth tokens" is enabled)
  // Access token expires in ~8 hours, refresh token expires in ~6 months
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
    const clientId = getWorkosClientId();
    if (!clientId) {
      throw new Error(
        "WORKOS_CLIENT_ID environment variable is not set. " +
          "Set it in your shell or .env file."
      );
    }

    const response = await fetch(
      `${WORKOS_API_BASE}/user_management/authorize/device`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId }),
      }
    );

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
  const clientId = getWorkosClientId();
  let pollInterval = interval;
  let attempts = 0;

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts++;
    await sleep(pollInterval * 1000);
    onPoll?.();

    const response = await fetch(
      `${WORKOS_API_BASE}/user_management/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: clientId,
        }),
      }
    );

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

export const refreshAccessToken = async (
  refreshToken: string
): Promise<TokenResponse> => {
  const clientId = getWorkosClientId();
  // Use the same /user_management/authenticate endpoint with refresh_token grant type
  // For CLI (public client) apps using device flow, client_secret is not required
  const response = await fetch(
    `${WORKOS_API_BASE}/user_management/authenticate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  return response.json() as Promise<TokenResponse>;
};

/**
 * Extract expiration time from JWT's exp claim
 */
export const getJwtExpiration = (token: string): number => {
  const payload = decodeJwt(token);
  if (typeof payload.exp === "number") {
    return payload.exp * 1000; // Convert seconds to milliseconds
  }
  // Fallback: 1 hour from now if no exp claim
  return Date.now() + 3600 * 1000;
};

export const getAccessToken = async (): Promise<string> => {
  const credentials = loadCredentials();

  if (!credentials) {
    throw new Error("Not logged in. Run `dt auth login` first.");
  }

  if (!isTokenExpired(credentials)) {
    return credentials.access_token;
  }

  const tokens = await refreshAccessToken(credentials.refresh_token);
  // Use the JWT's actual exp claim, not expires_in from response
  // Preserve existing GitHub tokens if still valid (WorkOS refresh doesn't return new GitHub tokens)
  const newCredentials: Credentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: getJwtExpiration(tokens.access_token),
    // Keep GitHub access token if it hasn't expired yet
    ...(credentials.github_token &&
      credentials.github_token_expires_at &&
      credentials.github_token_expires_at > Date.now() && {
        github_token: credentials.github_token,
        github_token_expires_at: credentials.github_token_expires_at,
      }),
    // Keep GitHub refresh token if it hasn't expired yet (6-month lifetime)
    ...(credentials.github_refresh_token &&
      credentials.github_refresh_token_expires_at &&
      credentials.github_refresh_token_expires_at > Date.now() && {
        github_refresh_token: credentials.github_refresh_token,
        github_refresh_token_expires_at:
          credentials.github_refresh_token_expires_at,
      }),
  };

  saveCredentials(newCredentials);
  return newCredentials.access_token;
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

/**
 * Check if GitHub access token is expired
 * Uses a 5-minute buffer for safety, same as WorkOS access token expiration check
 */
export const isGitHubTokenExpired = (credentials: Credentials): boolean => {
  if (!(credentials.github_token && credentials.github_token_expires_at)) {
    return true;
  }
  const bufferMs = 5 * 60 * 1000;
  return credentials.github_token_expires_at < Date.now() + bufferMs;
};

/**
 * Check if GitHub refresh token is expired
 * Uses a 1-hour buffer since refresh tokens have a 6-month lifetime
 */
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
  const bufferMs = 60 * 60 * 1000; // 1 hour buffer
  return credentials.github_refresh_token_expires_at < Date.now() + bufferMs;
};

/**
 * Refresh the GitHub OAuth token using the refresh token
 * Calls the API endpoint which handles the GitHub token exchange server-side
 */
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

    // Update credentials with new GitHub tokens
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
    // Return null silently - caller decides how to handle missing token
    // This avoids displaying error messages when CLI gracefully falls back
    return null;
  }
};

/**
 * Get GitHub OAuth token from credentials if available
 * Automatically refreshes the token if expired but refresh token is still valid
 *
 * Returns null if:
 * - No credentials exist
 * - No GitHub token stored
 * - GitHub token is expired AND refresh failed or not available
 */
export const getGitHubToken = async (): Promise<string | null> => {
  const credentials = loadCredentials();
  if (!credentials?.github_token) {
    return null;
  }

  // Return token if not expired
  if (!isGitHubTokenExpired(credentials)) {
    return credentials.github_token;
  }

  // Token is expired - try to refresh if we have a refresh token
  if (
    credentials.github_refresh_token &&
    !isGitHubRefreshTokenExpired(credentials)
  ) {
    try {
      // Get a valid WorkOS access token first (may need refresh itself)
      const accessToken = await getAccessToken();
      const newCredentials = await refreshGitHubTokenInternal(
        accessToken,
        credentials
      );
      if (newCredentials?.github_token) {
        return newCredentials.github_token;
      }
    } catch {
      // Failed to refresh - return null
    }
  }

  // Token expired and couldn't refresh
  return null;
};

export interface TokenHealthStatus {
  workos: "valid" | "expired" | "refresh_needed" | "missing";
  github:
    | "valid"
    | "expired"
    | "refresh_needed"
    | "refresh_available"
    | "missing";
}

/**
 * Check health of stored tokens without throwing
 * Returns status object for caller to handle (e.g., show warnings on CLI startup)
 * Synchronous - only checks local token expiration, no API calls
 */
export const checkTokenHealth = (): TokenHealthStatus => {
  const credentials = loadCredentials();

  if (!credentials) {
    return { workos: "missing", github: "missing" };
  }

  // Check WorkOS token
  const workosStatus: TokenHealthStatus["workos"] = isTokenExpired(credentials)
    ? "refresh_needed"
    : "valid";

  // Check GitHub token
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

  return { workos: workosStatus, github: githubStatus };
};

/**
 * Authenticate via Navigator (browser-based flow)
 * Opens browser to Navigator app which handles WorkOS auth,
 * then receives callback on localhost with encrypted tokens.
 */
export const authenticateViaNavigator = async (): Promise<TokenResponse> => {
  const { openBrowser } = await import("./browser.js");
  const { generateState, startCallbackServer } = await import(
    "./localhost-server.js"
  );

  const authBaseUrl = getAuthUrl();
  const state = generateState();
  const server = await startCallbackServer(state);
  const authUrl = `${authBaseUrl}/cli/auth?port=${server.port}&state=${state}`;

  try {
    await openBrowser(authUrl);
  } catch {
    console.log(`\nPlease open this URL in your browser:\n  ${authUrl}\n`);
  }

  const { code } = await server.waitForCallback();

  const response = await fetch(`${authBaseUrl}/api/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    github_token?: string;
    github_token_expires_at?: number;
    github_refresh_token?: string;
    github_refresh_token_expires_at?: number;
  };

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: "Bearer",
    expires_in: Math.floor((tokens.expires_at - Date.now()) / 1000),
    // Pass through GitHub OAuth tokens if available
    github_token: tokens.github_token,
    github_token_expires_at: tokens.github_token_expires_at,
    github_refresh_token: tokens.github_refresh_token,
    github_refresh_token_expires_at: tokens.github_refresh_token_expires_at,
  };
};
