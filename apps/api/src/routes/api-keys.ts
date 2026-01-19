/**
 * API Keys management routes
 *
 * Enables organizations to create and manage API keys for external integrations.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { apiKeys } from "../db/schema";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  requireRole,
} from "../middleware/github-org-access";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

/**
 * Generate a secure API key with "dtk_" prefix
 * Uses 24 bytes (192 bits) of randomness, base64url encoded
 */
const generateApiKey = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // Base64url encode (URL-safe, no padding)
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `dtk_${encoded}`;
};

/**
 * POST /:orgId/api-keys
 * Create a new API key for the organization
 * Only owners and admins can create keys
 */
app.post(
  "/:orgId/api-keys",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    const body = await c.req.json<{ name: string }>();
    const { name } = body;

    if (!name || name.trim().length === 0) {
      return c.json({ error: "name is required" }, 400);
    }

    if (name.length > 255) {
      return c.json({ error: "name must be 255 characters or less" }, 400);
    }

    const { db, client } = await createDb(c.env);
    try {
      const keyId = crypto.randomUUID();
      const key = generateApiKey();

      await db.insert(apiKeys).values({
        id: keyId,
        organizationId: organization.id,
        key,
        name: name.trim(),
      });

      // Return the key only on creation - it won't be retrievable later
      return c.json(
        {
          id: keyId,
          key, // Only returned on creation
          name: name.trim(),
          created_at: new Date().toISOString(),
        },
        201
      );
    } finally {
      await client.end();
    }
  }
);

/**
 * GET /:orgId/api-keys
 * List all API keys for the organization (without the actual key values)
 */
app.get(
  "/:orgId/api-keys",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    const { db, client } = await createDb(c.env);
    try {
      const keys = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.organizationId, organization.id));

      return c.json({
        api_keys: keys.map((k) => ({
          id: k.id,
          name: k.name,
          created_at: k.createdAt.toISOString(),
          last_used_at: k.lastUsedAt?.toISOString() ?? null,
        })),
      });
    } finally {
      await client.end();
    }
  }
);

/**
 * DELETE /:orgId/api-keys/:keyId
 * Revoke an API key
 */
app.delete(
  "/:orgId/api-keys/:keyId",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;
    const keyId = c.req.param("keyId");

    const { db, client } = await createDb(c.env);
    try {
      const result = await db
        .delete(apiKeys)
        .where(
          and(
            eq(apiKeys.id, keyId),
            eq(apiKeys.organizationId, organization.id)
          )
        )
        .returning({ id: apiKeys.id });

      if (result.length === 0) {
        return c.json({ error: "API key not found" }, 404);
      }

      return c.json({ success: true, deleted_id: keyId });
    } finally {
      await client.end();
    }
  }
);

export default app;
