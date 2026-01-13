import { decodeJwt, EncryptJWT } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  type GitHubOAuthTokens,
  getGitHubOAuthTokens,
  getWorkOSCookiePassword,
} from "@/lib/auth";
import { COOKIE_NAMES } from "@/lib/constants";
import { workos } from "@/lib/workos";

/**
 * Check if sealed sessions are enabled (required for CLI auth)
 * CLI auth needs refresh tokens which are only available with sealed sessions
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
 * Create encrypted one-time code containing tokens
 * Uses JWE with direct encryption (A256GCM) for secure token transport
 */
const createEncryptedCode = async (
  accessToken: string,
  refreshToken: string,
  oauthTokens?: GitHubOAuthTokens | null
) => {
  // A256GCM requires exactly 256 bits (32 bytes) key
  // Hash the password to get consistent 32-byte key
  const password = getWorkOSCookiePassword();
  const passwordBytes = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", passwordBytes);
  const encryptionKey = new Uint8Array(hashBuffer);

  const encryptedCode = await new EncryptJWT({
    accessToken,
    refreshToken,
    // Include GitHub OAuth token if available (from "Return GitHub OAuth tokens" setting)
    ...(oauthTokens && { oauthTokens }),
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setExpirationTime("60s")
    .encrypt(encryptionKey);

  return encryptedCode;
};

/**
 * CLI Authorization endpoint
 * User must already be authenticated via Navigator
 * Generates encrypted tokens and redirects to CLI's localhost server
 */
export const GET = async (request: Request) => {
  const url = new URL(request.url);
  const port = url.searchParams.get("port");
  const state = url.searchParams.get("state");

  // Validate required parameters
  if (!(port && state)) {
    return NextResponse.redirect(
      new URL("/cli/auth?error=missing_params", request.url)
    );
  }

  // Validate port is a valid number to prevent URL manipulation attacks
  const portNumber = Number.parseInt(port, 10);
  if (
    Number.isNaN(portNumber) ||
    portNumber < 1 ||
    portNumber > 65_535 ||
    port !== String(portNumber)
  ) {
    return NextResponse.redirect(
      new URL("/cli/auth?error=invalid_port", request.url)
    );
  }

  // CLI auth requires sealed sessions (for refresh tokens)
  if (!isSealedSessionsEnabled()) {
    return NextResponse.redirect(
      new URL("/cli/auth?error=sealed_sessions_required", request.url)
    );
  }

  const returnUrl = `/cli/auth?port=${encodeURIComponent(port)}&state=${encodeURIComponent(state)}`;

  // Get existing session cookies
  const cookieStore = await cookies();
  const sealedSession = cookieStore.get(COOKIE_NAMES.workosSession)?.value;
  const sessionCookie = cookieStore.get(COOKIE_NAMES.session)?.value;

  if (!sealedSession) {
    // No WorkOS session cookie - need to force re-authentication
    // If user has old session cookie but no workosSession, clear it to avoid redirect loop
    if (sessionCookie) {
      cookieStore.delete(COOKIE_NAMES.session);
    }
    return NextResponse.redirect(
      new URL(`/login?returnTo=${encodeURIComponent(returnUrl)}`, request.url)
    );
  }

  try {
    const cookiePassword = getWorkOSCookiePassword();
    const session = workos.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword,
    });

    // Refresh the session to get fresh tokens
    const refreshResult = await session.refresh({ cookiePassword });

    if (!(refreshResult.authenticated && refreshResult.session)) {
      // Session expired - clear both cookies to force full re-authentication
      cookieStore.delete(COOKIE_NAMES.session);
      cookieStore.delete(COOKIE_NAMES.workosSession);
      return NextResponse.redirect(
        new URL(`/login?returnTo=${encodeURIComponent(returnUrl)}`, request.url)
      );
    }

    const { accessToken, refreshToken } = refreshResult.session;
    if (!(accessToken && refreshToken)) {
      throw new Error("Missing tokens in session");
    }

    // Get GitHub OAuth tokens from separate cookie
    // Note: oauthTokens are NOT stored in WorkOS sealed session and NOT returned from refresh.
    // They are only returned during initial auth, so we persist them separately.
    const oauthTokens = await getGitHubOAuthTokens();

    // Extract user email from access token for success page display
    const { email } = decodeJwt(accessToken) as { email?: string };

    // Create encrypted one-time code (includes GitHub OAuth token if available)
    const encryptedCode = await createEncryptedCode(
      accessToken,
      refreshToken,
      oauthTokens
    );

    // Build redirect URL to CLI's localhost server (use validated portNumber)
    const cliCallbackUrl = new URL(`http://localhost:${portNumber}/callback`);
    cliCallbackUrl.searchParams.set("code", encryptedCode);
    cliCallbackUrl.searchParams.set("state", state);
    if (email) {
      cliCallbackUrl.searchParams.set("email", email);
    }

    // Redirect directly to CLI callback (success page shown by CLI)
    return NextResponse.redirect(cliCallbackUrl.toString());
  } catch (err) {
    console.error("[cli/auth/authorize] Error:", err);
    return NextResponse.redirect(
      new URL("/cli/auth?error=auth_failed", request.url)
    );
  }
};
