import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { createDb } from "../db/client";
import { apiKeys } from "../db/schema";
import type { Env } from "../types/env";

interface ApiKeyAuthContext {
  organizationId: string;
}

declare module "hono" {
  interface ContextVariableMap {
    apiKeyAuth: ApiKeyAuthContext;
  }
}

const API_KEY_PREFIX = "dtk_";

export const apiKeyAuthMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | undefined> => {
  const token = c.req.header("X-Detent-Token");

  if (!token) {
    return c.json({ error: "Missing X-Detent-Token header" }, 401);
  }

  if (!token.startsWith(API_KEY_PREFIX)) {
    return c.json({ error: "Invalid token format" }, 401);
  }

  const { db, client } = await createDb(c.env);
  try {
    const apiKey = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.key, token),
    });

    if (!apiKey) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKey.id));

    c.set("apiKeyAuth", {
      organizationId: apiKey.organizationId,
    });

    await next();
    return undefined;
  } finally {
    await client.end();
  }
};
