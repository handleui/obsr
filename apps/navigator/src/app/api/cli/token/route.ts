import { decodeJwt, jwtDecrypt } from "jose";
import { NextResponse } from "next/server";
import { getWorkOSCookiePassword } from "@/lib/auth";
import { type BetterStackRequest, withLogging } from "@/lib/logger";

interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
}

interface TokenPayload {
  accessToken: string;
  refreshToken: string;
  oauthTokens?: OAuthTokens;
  exp: number;
}

interface TokenRequestBody {
  code: string;
}

/**
 * API route to exchange encrypted one-time code for tokens
 * This is called by the CLI after receiving the encrypted code from the callback
 */
const handler = async (request: BetterStackRequest) => {
  const { log } = request;

  try {
    const body = (await request.json()) as TokenRequestBody;
    const { code } = body;

    if (!code) {
      log.warn("Token exchange failed: missing code");
      return NextResponse.json(
        { error: "missing_code", message: "Code is required" },
        { status: 400 }
      );
    }

    // Decrypt the one-time code
    // Use SHA-256 hash of password for consistent 256-bit key (matches authorize route)
    const password = getWorkOSCookiePassword();
    const passwordBytes = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", passwordBytes);
    const encryptionKey = new Uint8Array(hashBuffer);

    let payload: TokenPayload;
    try {
      const result = await jwtDecrypt(code, encryptionKey);
      payload = result.payload as unknown as TokenPayload;
    } catch {
      log.warn("Token exchange failed: invalid code");
      return NextResponse.json(
        { error: "invalid_code", message: "Invalid or expired code" },
        { status: 400 }
      );
    }

    // Verify expiration (jose already handles this, but double-check)
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      log.warn("Token exchange failed: expired code");
      return NextResponse.json(
        { error: "expired_code", message: "Code has expired" },
        { status: 400 }
      );
    }

    // Extract tokens
    const { accessToken, refreshToken, oauthTokens } = payload;

    if (!(accessToken && refreshToken)) {
      log.warn("Token exchange failed: invalid payload");
      return NextResponse.json(
        { error: "invalid_payload", message: "Invalid token payload" },
        { status: 400 }
      );
    }

    // Extract actual expiration from JWT exp claim
    const { exp } = decodeJwt(accessToken);
    const expiresAt = exp
      ? new Date(exp * 1000).toISOString()
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // GitHub refresh tokens expire after 6 months (15897600 seconds)
    const GITHUB_REFRESH_TOKEN_LIFETIME_MS = 15_897_600 * 1000;

    log.info("Token exchange successful", {
      hasGitHubTokens: !!oauthTokens,
      hasGitHubRefreshToken: !!oauthTokens?.refreshToken,
    });

    // Build response with GitHub tokens if available
    const response: Record<string, unknown> = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
    };

    if (oauthTokens?.accessToken) {
      response.github_token = oauthTokens.accessToken;
      // Only include expires_at if token actually expires (non-zero)
      if (oauthTokens.expiresAt) {
        response.github_token_expires_at = oauthTokens.expiresAt * 1000;
      }
      // Only include refresh token if present (GitHub classic OAuth doesn't have one)
      if (oauthTokens.refreshToken) {
        response.github_refresh_token = oauthTokens.refreshToken;
        response.github_refresh_token_expires_at =
          Date.now() + GITHUB_REFRESH_TOKEN_LIFETIME_MS;
      }
    }

    return NextResponse.json(response);
  } catch (err) {
    log.error("Token exchange error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json(
      { error: "server_error", message: "An unexpected error occurred" },
      { status: 500 }
    );
  }
};

export const POST = withLogging(handler, "api/cli/token");
