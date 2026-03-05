/**
 * JWT authentication middleware
 *
 * Validates bearer access tokens from configured auth provider.
 * Sets userId and organizationId in context for downstream handlers.
 */

import type { Context, Next } from "hono";
import { resolveAuthProvider } from "../auth/auth-provider";
import type { Env } from "../types/env";

const BEARER_TOKEN_REGEX = /^Bearer\s+(.+)$/i;

const extractBearerToken = (header: string | undefined): string | null => {
  if (!header) {
    return null;
  }
  const match = header.match(BEARER_TOKEN_REGEX);
  return match?.[1] ?? null;
};

export const authMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | undefined> => {
  const token = extractBearerToken(c.req.header("authorization"));
  const authProvider = resolveAuthProvider(c.env);

  if (!token) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  try {
    const principal = await authProvider.verifyBearerToken(token, c.env);

    c.set("auth", {
      userId: principal.userId,
      organizationId: principal.organizationId,
    });

    await next();
    return undefined;
  } catch (error) {
    // Log verification failure details for debugging
    console.error("Token verification failed:", {
      error: error instanceof Error ? error.message : String(error),
      provider: authProvider.name,
    });
    return c.json({ error: "Invalid or expired token" }, 401);
  }
};
