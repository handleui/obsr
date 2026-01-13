/**
 * Shared constants for auth that can be used in both server and client components
 */

export const VERIFICATION_CODE_LENGTH = 6;

/**
 * Detent API base URL
 * Used for server-side API calls (e.g., invitation acceptance)
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "https://api.detent.sh";

export const COOKIE_NAMES = {
  session: "session",
  /** WorkOS sealed session cookie - contains encrypted refresh token */
  workosSession: "wos_session",
  oauthState: "oauth_state",
  pendingVerification: "pending_verification",
  /** CLI auth params cookie - stores port and state for CLI OAuth flow */
  cliAuthParams: "cli_auth_params",
  /** Return URL after authentication */
  returnTo: "return_to",
  /**
   * GitHub OAuth tokens cookie - stores signed GitHub access/refresh tokens (HS256 JWT)
   * Tokens are base64-encoded and integrity-protected via HMAC signing, not encrypted
   * These are captured from initial WorkOS authentication when "Return GitHub OAuth tokens" is enabled
   * Note: oauthTokens are NOT stored in WorkOS sealed session, so we persist them separately
   */
  githubOAuthTokens: "github_oauth_tokens",
} as const;

export const AUTH_DURATIONS = {
  /** Session cookie max age in seconds (24 hours) */
  sessionMaxAgeSec: 60 * 60 * 24,
  /** OAuth state cookie max age in seconds (10 minutes) */
  oauthStateMaxAgeSec: 60 * 10,
  /** Pending verification cookie max age in seconds (10 minutes) */
  pendingVerificationMaxAgeSec: 60 * 10,
  /** Pending verification expiry in milliseconds (10 minutes) */
  pendingVerificationMs: 10 * 60 * 1000,
  /** CLI auth params cookie max age in seconds (10 minutes) */
  cliAuthParamsMaxAgeSec: 60 * 10,
  /** GitHub OAuth tokens cookie max age in seconds (same as session - 24 hours) */
  githubOAuthTokensMaxAgeSec: 60 * 60 * 24,
} as const;
