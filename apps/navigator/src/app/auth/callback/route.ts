import { NextResponse } from "next/server";
import {
  createGitHubOAuthTokensToken,
  createPendingVerificationToken,
  createSecureCookieOptions,
  createSession,
  type GitHubOAuthTokens,
  getAndClearReturnTo,
  getWorkOSClientId,
  getWorkOSCookiePassword,
  sanitizeReturnUrl,
  verifyAndClearOAuthState,
} from "@/lib/auth";
import { AUTH_DURATIONS, COOKIE_NAMES } from "@/lib/constants";
import { type BetterStackRequest, withLogging } from "@/lib/logger";
import { workos } from "@/lib/workos";

/**
 * Check if WorkOS sealed sessions are enabled
 * When enabled, WorkOS encrypts the refresh token into a sealed session cookie
 * This is more secure as it prevents token theft and enables server-side token refresh
 */
const isSealedSessionsEnabled = () => {
  try {
    getWorkOSCookiePassword();
    return true;
  } catch {
    return false;
  }
};

/**
 * Type guard for WorkOS email verification required error
 * This error is thrown when GitHub OAuth user hasn't verified their email
 *
 * Actual WorkOS error structure:
 * {
 *   code: "email_verification_required",
 *   message: "Email ownership must be verified before authentication.",
 *   email: "user@example.com",
 *   pending_authentication_token: "...",
 *   email_verification_id: "email_verification_..."
 * }
 *
 * Note: WorkOS auto-sends the verification email when this error occurs
 */
interface EmailVerificationRequiredError {
  code: string;
  rawData: {
    code: string;
    pending_authentication_token: string;
    email: string;
    email_verification_id: string;
  };
}

const isEmailVerificationError = (
  error: unknown
): error is EmailVerificationRequiredError => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const err = error as Record<string, unknown>;
  const rawData = err.rawData as Record<string, unknown> | undefined;
  const codeMatches =
    err.code === "email_verification_required" ||
    rawData?.code === "email_verification_required";
  return codeMatches && !!rawData?.pending_authentication_token;
};

/**
 * Type guard for GitHub OAuth tokens from WorkOS
 * Validates that the object has the expected shape before casting
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isValidGitHubOAuthTokens = (data: unknown): data is GitHubOAuthTokens => {
  if (!isRecord(data)) {
    return false;
  }
  // Check for non-empty strings (empty string is still a string but useless)
  const hasValidAccessToken =
    typeof data.accessToken === "string" && data.accessToken.length > 0;
  const hasValidRefreshToken =
    typeof data.refreshToken === "string" && data.refreshToken.length > 0;
  const hasValidExpiry = typeof data.expiresAt === "number";
  const hasValidScopes =
    Array.isArray(data.scopes) &&
    data.scopes.every((scope) => typeof scope === "string");

  return (
    hasValidAccessToken &&
    hasValidRefreshToken &&
    hasValidExpiry &&
    hasValidScopes
  );
};

/**
 * Set pending verification cookie for email verification flow
 * Uses signed JWT to protect the pendingAuthenticationToken from tampering
 */
const setPendingVerificationCookie = async (
  response: NextResponse,
  data: {
    pendingAuthenticationToken: string;
    email: string;
    emailVerificationId: string;
  }
) => {
  const signedToken = await createPendingVerificationToken(data);
  response.cookies.set(
    createSecureCookieOptions({
      name: COOKIE_NAMES.pendingVerification,
      value: signedToken,
      maxAge: AUTH_DURATIONS.pendingVerificationMaxAgeSec,
    })
  );
};

/**
 * Build auth options based on whether sealed sessions are enabled
 */
const buildAuthOptions = (code: string, shouldSealSession: boolean) => {
  if (shouldSealSession) {
    return {
      clientId: getWorkOSClientId(),
      code,
      session: {
        sealSession: true,
        cookiePassword: getWorkOSCookiePassword(),
      },
    };
  }
  return {
    clientId: getWorkOSClientId(),
    code,
  };
};

/**
 * Debug log OAuth tokens from WorkOS response
 */
const logOAuthTokensDebug = (rawOauthTokens: unknown) => {
  if (!rawOauthTokens) {
    console.log("[auth/callback] WorkOS authResponse.oauthTokens:", "null");
    return;
  }

  const tokens = rawOauthTokens as Record<string, unknown>;
  console.log("[auth/callback] WorkOS authResponse.oauthTokens:", {
    hasAccessToken: Boolean(tokens.accessToken),
    accessTokenLength:
      typeof tokens.accessToken === "string"
        ? tokens.accessToken.length
        : "N/A",
    hasRefreshToken: Boolean(tokens.refreshToken),
    refreshTokenLength:
      typeof tokens.refreshToken === "string"
        ? tokens.refreshToken.length
        : "N/A",
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
  });
};

/**
 * Set session cookies on the response
 */
const setSessionCookies = async (
  response: NextResponse,
  authResponse: { user: { id: string }; sealedSession?: string },
  shouldSealSession: boolean
) => {
  const token = await createSession(authResponse.user);
  response.cookies.set(
    createSecureCookieOptions({
      name: COOKIE_NAMES.session,
      value: token,
      maxAge: AUTH_DURATIONS.sessionMaxAgeSec,
    })
  );

  if (shouldSealSession && "sealedSession" in authResponse) {
    response.cookies.set(
      createSecureCookieOptions({
        name: COOKIE_NAMES.workosSession,
        value: authResponse.sealedSession as string,
        maxAge: AUTH_DURATIONS.sessionMaxAgeSec,
      })
    );
  }
};

/**
 * Process and store GitHub OAuth tokens if available
 */
const processGitHubTokens = async (
  response: NextResponse,
  rawOauthTokens: unknown,
  log: BetterStackRequest["log"]
) => {
  logOAuthTokensDebug(rawOauthTokens);

  const githubTokens = isValidGitHubOAuthTokens(rawOauthTokens)
    ? rawOauthTokens
    : null;

  if (!githubTokens && rawOauthTokens) {
    console.log(
      "[auth/callback] GitHub tokens validation FAILED - rawOauthTokens exists but is invalid"
    );
    return false;
  }

  if (githubTokens) {
    const oauthTokensJwt = await createGitHubOAuthTokensToken(githubTokens);
    log.info("Setting github_oauth_tokens cookie", {
      cookieName: COOKIE_NAMES.githubOAuthTokens,
      jwtLength: oauthTokensJwt.length,
    });
    response.cookies.set(
      createSecureCookieOptions({
        name: COOKIE_NAMES.githubOAuthTokens,
        value: oauthTokensJwt,
        maxAge: AUTH_DURATIONS.githubOAuthTokensMaxAgeSec,
      })
    );
    return true;
  }

  return false;
};

const handler = async (request: BetterStackRequest) => {
  const { log } = request;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Check for OAuth errors from WorkOS
  if (error) {
    log.error("OAuth callback error", { error, errorDescription });
    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(error)}&message=${encodeURIComponent(errorDescription || "")}`,
        request.url
      )
    );
  }

  // Verify OAuth state to prevent CSRF attacks
  const isValidState = await verifyAndClearOAuthState(state);

  if (!isValidState) {
    log.warn("OAuth callback: invalid state (potential CSRF)");
    return NextResponse.redirect(
      new URL("/login?error=invalid_state", request.url)
    );
  }

  if (!code) {
    log.warn("OAuth callback: missing code");
    return NextResponse.redirect(new URL("/login?error=no_code", request.url));
  }

  try {
    const shouldSealSession = isSealedSessionsEnabled();
    const authOptions = buildAuthOptions(code, shouldSealSession);

    const authResponse = await workos.userManagement.authenticateWithCode(
      authOptions as Parameters<
        typeof workos.userManagement.authenticateWithCode
      >[0]
    );
    const { user } = authResponse;

    // Get returnTo URL and sanitize it (defense in depth against open redirect)
    const returnTo = await getAndClearReturnTo();
    const redirectUrl = sanitizeReturnUrl(returnTo);

    const response = NextResponse.redirect(new URL(redirectUrl, request.url));

    // Set session cookies
    await setSessionCookies(response, authResponse, shouldSealSession);

    // Store GitHub OAuth tokens separately if available
    // Note: oauthTokens are only returned during initial authentication and are NOT
    // stored in the WorkOS sealed session. We must persist them in a separate cookie
    // for later use (e.g., CLI auth flow that needs the GitHub token).
    const rawOauthTokens =
      "oauthTokens" in authResponse ? authResponse.oauthTokens : null;

    const hasGitHubTokens = await processGitHubTokens(
      response,
      rawOauthTokens,
      log
    );

    log.info("User authenticated successfully", {
      userId: user.id,
      hasGitHubTokens,
      sealedSession: shouldSealSession,
    });

    return response;
  } catch (error) {
    // Handle email verification required error (GitHub OAuth specific)
    if (isEmailVerificationError(error)) {
      log.info("Email verification required", {
        email: error.rawData.email,
      });

      const pendingData = {
        pendingAuthenticationToken: error.rawData.pending_authentication_token,
        email: error.rawData.email,
        emailVerificationId: error.rawData.email_verification_id,
      };

      const response = NextResponse.redirect(
        new URL("/verify-email", request.url)
      );
      await setPendingVerificationCookie(response, pendingData);
      return response;
    }

    log.error("Authentication failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.redirect(
      new URL("/login?error=auth_failed", request.url)
    );
  }
};

export const GET = withLogging(handler, "auth/callback");
