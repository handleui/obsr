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
import { API_BASE_URL, AUTH_DURATIONS, COOKIE_NAMES } from "@/lib/constants";
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
const isValidGitHubOAuthTokens = (data: unknown): data is GitHubOAuthTokens => {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.accessToken === "string" &&
    typeof obj.refreshToken === "string" &&
    typeof obj.expiresAt === "number" &&
    Array.isArray(obj.scopes) &&
    obj.scopes.every((scope) => typeof scope === "string")
  );
};

/**
 * Sync identity with API to auto-claim organizations (mirrors CLI flow)
 * Non-blocking - errors are logged but don't fail the auth flow
 */
const syncIdentity = async (accessToken: string): Promise<void> => {
  await fetch(`${API_BASE_URL}/v1/auth/sync-identity`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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
    const authOptions = shouldSealSession
      ? {
          clientId: getWorkOSClientId(),
          code,
          session: {
            sealSession: true,
            cookiePassword: getWorkOSCookiePassword(),
          },
        }
      : {
          clientId: getWorkOSClientId(),
          code,
        };

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

    // Store the custom session token for user data access
    const token = await createSession(user);
    response.cookies.set(
      createSecureCookieOptions({
        name: COOKIE_NAMES.session,
        value: token,
        maxAge: AUTH_DURATIONS.sessionMaxAgeSec,
      })
    );

    // If using sealed sessions, also store the WorkOS sealed session
    // This contains the encrypted refresh token for token refresh capability
    if (shouldSealSession && "sealedSession" in authResponse) {
      response.cookies.set(
        createSecureCookieOptions({
          name: COOKIE_NAMES.workosSession,
          value: authResponse.sealedSession as string,
          maxAge: AUTH_DURATIONS.sessionMaxAgeSec,
        })
      );
    }

    // Store GitHub OAuth tokens separately if available
    // Note: oauthTokens are only returned during initial authentication and are NOT
    // stored in the WorkOS sealed session. We must persist them in a separate cookie
    // for later use (e.g., CLI auth flow that needs the GitHub token).
    const hasGitHubTokens =
      "oauthTokens" in authResponse &&
      isValidGitHubOAuthTokens(authResponse.oauthTokens);

    if (hasGitHubTokens) {
      const oauthTokensJwt = await createGitHubOAuthTokensToken(
        authResponse.oauthTokens as GitHubOAuthTokens
      );
      response.cookies.set(
        createSecureCookieOptions({
          name: COOKIE_NAMES.githubOAuthTokens,
          value: oauthTokensJwt,
          maxAge: AUTH_DURATIONS.githubOAuthTokensMaxAgeSec,
        })
      );
    }

    // Sync identity to auto-claim organizations (mirrors CLI flow)
    if ("accessToken" in authResponse) {
      syncIdentity(authResponse.accessToken as string).catch((syncError) => {
        log.warn("Failed to sync identity", {
          error:
            syncError instanceof Error ? syncError.message : String(syncError),
        });
      });
    }

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
