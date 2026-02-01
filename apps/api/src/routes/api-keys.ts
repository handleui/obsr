/**
 * API Keys management routes
 *
 * Enables organizations to create and manage API keys for external integrations.
 */

import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import { generateApiKey, hashApiKey } from "../lib/crypto";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  requireRole,
} from "../middleware/github-org-access";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

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

    let body: { name: string };
    try {
      body = await c.req.json<{ name: string }>();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const { name } = body;

    if (!name || name.trim().length === 0) {
      return c.json({ error: "name is required" }, 400);
    }

    if (name.length > 255) {
      return c.json({ error: "name must be 255 characters or less" }, 400);
    }

    const convex = getConvexClient(c.env);
    const key = generateApiKey();
    const keyHash = await hashApiKey(key);
    const keyPrefix = key.substring(0, 8); // "dtk_XXXX"

    const keyId = (await convex.mutation("api-keys:create", {
      organizationId: organization._id,
      keyHash,
      keyPrefix,
      name: name.trim(),
      createdAt: Date.now(),
    })) as string;

    // Return the key only on creation - it cannot be retrieved later
    return c.json(
      {
        id: keyId,
        key, // Full key returned ONLY on creation
        key_prefix: keyPrefix,
        name: name.trim(),
        created_at: new Date().toISOString(),
      },
      201
    );
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

    const convex = getConvexClient(c.env);
    const keys = (await convex.query("api-keys:listByOrg", {
      organizationId: organization._id,
    })) as Array<{
      _id: string;
      keyPrefix: string;
      name: string;
      createdAt: number;
      lastUsedAt?: number;
    }>;

    return c.json({
      api_keys: keys.map((k) => ({
        id: k._id,
        key_prefix: k.keyPrefix,
        name: k.name,
        created_at: new Date(k.createdAt).toISOString(),
        last_used_at: k.lastUsedAt
          ? new Date(k.lastUsedAt).toISOString()
          : null,
      })),
    });
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
    const { invalidateApiKeyCache } = await import(
      "../middleware/api-key-auth"
    );

    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;
    const keyId = c.req.param("keyId");
    const kv = c.env["detent-idempotency"];

    const convex = getConvexClient(c.env);
    const existing = (await convex.query("api-keys:getById", {
      id: keyId,
    })) as { _id: string; organizationId: string; keyHash: string } | null;

    if (!existing || existing.organizationId !== organization._id) {
      return c.json({ error: "API key not found" }, 404);
    }

    await convex.mutation("api-keys:remove", { id: keyId });

    // Invalidate the cache in background (uses hash-based key)
    c.executionCtx.waitUntil(invalidateApiKeyCache(existing.keyHash, kv));

    return c.json({ success: true, deleted_id: keyId });
  }
);

export default app;
