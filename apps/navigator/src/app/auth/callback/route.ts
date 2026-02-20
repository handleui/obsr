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
  verifyAndClearOAuthState,
} from "@/lib/auth";
import { AUTH_DURATIONS, COOKIE_NAMES } from "@/lib/constants";
import { type BetterStackRequest, withLogging } from "@/lib/logger";
import { sanitizeReturnUrl } from "@/lib/return-url";
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
  // Only accessToken is required - refreshToken/expiresAt are optional
  // (GitHub classic OAuth tokens don't expire and don't have refresh tokens)
  const hasValidAccessToken =
    typeof data.accessToken === "string" && data.accessToken.length > 0;
  const hasValidScopes =
    Array.isArray(data.scopes) &&
    data.scopes.every((scope) => typeof scope === "string");

  return hasValidAccessToken && hasValidScopes;
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
 * Set session cookies on the response
 */
const setSessionCookies = async (
  response: NextResponse,
  authResponse: {
    user: {
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      profilePictureUrl: string | null;
    };
    sealedSession?: string;
  },
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
  rawOauthTokens: unknown
) => {
  const githubTokens = isValidGitHubOAuthTokens(rawOauthTokens)
    ? rawOauthTokens
    : null;

  if (githubTokens) {
    const oauthTokensJwt = await createGitHubOAuthTokensToken(githubTokens);
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

/**
 * Sync identity and auto-join orgs via API
 * Non-blocking: failures are logged but don't break auth flow
 */
const syncIdentityWithApi = async (
  authResponse: { sealedSession?: string },
  rawOauthTokens: unknown,
  log: BetterStackRequest["log"]
): Promise<void> => {
  if (!authResponse.sealedSession) {
    return;
  }

  try {
    const cookiePassword = getWorkOSCookiePassword();
    const session = workos.userManagement.loadSealedSession({
      sessionData: authResponse.sealedSession,
      cookiePassword,
    });

    const refreshResult = await session.refresh({ cookiePassword });
    if (!(refreshResult.authenticated && refreshResult.session?.accessToken)) {
      return;
    }

    const accessToken = refreshResult.session.accessToken;

    const headers: HeadersInit = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    // Add GitHub token for org auto-join
    if (isValidGitHubOAuthTokens(rawOauthTokens)) {
      headers["X-GitHub-Token"] = rawOauthTokens.accessToken;
    }

    const apiUrl =
      process.env.NEXT_PUBLIC_API_URL ?? "https://backend.detent.sh";
    const response = await fetch(`${apiUrl}/v1/auth/sync-user`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      log.warn("Sync user returned non-OK", { status: response.status });
    }
  } catch (error) {
    // Non-blocking: log and continue (CLI will sync as fallback)
    log.warn("Failed to sync user in callback", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const handler = async (request: BetterStackRequest) => {
  const { log } = request;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  // Check for OAuth errors from WorkOS/GitHub
  // Common errors: access_denied (user cancelled), server_error, temporarily_unavailable
  if (error) {
    log.error("OAuth callback error from provider", {
      error,
      errorDescription,
    });
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

  // Validate authorization code parameter
  if (!code || typeof code !== "string" || code.trim().length === 0) {
    log.warn("OAuth callback: missing or invalid code parameter");
    return NextResponse.redirect(new URL("/login?error=no_code", request.url));
  }

  try {
    const shouldSealSession = isSealedSessionsEnabled();

    // Build auth options - WorkOS SDK handles code exchange and token validation
    const authOptions = buildAuthOptions(code, shouldSealSession);

    // Exchange authorization code for user session
    // WorkOS validates the code and returns user info + optional sealed session
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

    const hasGitHubTokens = await processGitHubTokens(response, rawOauthTokens);

    // Sync identity and auto-join orgs (non-blocking)
    await syncIdentityWithApi(authResponse, rawOauthTokens, log);

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
