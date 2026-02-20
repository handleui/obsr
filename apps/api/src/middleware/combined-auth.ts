/**
 * Combined authentication middleware
 *
 * Accepts either JWT (Authorization: Bearer) or API key (X-Detent-Token).
 * Routes to the appropriate auth middleware based on which header is present.
 */

import type { Context, Next } from "hono";
import type { Env } from "../types/env";
import { apiKeyAuthMiddleware } from "./api-key-auth";
import { authMiddleware } from "./auth";

export const combinedAuthMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | undefined> => {
  const authHeader = c.req.header("authorization");
  const apiKeyToken = c.req.header("X-Detent-Token");

  // Reject requests with both auth mechanisms to prevent ambiguity.
  // An attacker could send a valid API key + invalid JWT (or vice versa)
  // to probe for unexpected behavior in the auth selection logic.
  if (authHeader && apiKeyToken) {
    return c.json({ error: "Provide only one authentication method" }, 400);
  }

  if (authHeader) {
    return await authMiddleware(c, next);
  }
  if (apiKeyToken) {
    return await apiKeyAuthMiddleware(c, next);
  }
  return c.json({ error: "Authentication required" }, 401);
};
