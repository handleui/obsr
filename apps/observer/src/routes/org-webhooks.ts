import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import { encryptToken } from "../lib/encryption";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  requireRole,
} from "../middleware/github-org-access";
import type { Env } from "../types/env";

const VALID_EVENTS = new Set([
  "resolve.pending",
  "resolve.running",
  "resolve.completed",
  "resolve.applied",
  "resolve.rejected",
  "resolve.failed",
]);

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT range 100.64.0.0/10
  /^198\.1[89]\./, // benchmarking 198.18.0.0/15
  /^192\.0\.0\./, // IETF protocol assignments
  /^192\.0\.2\./, // documentation TEST-NET-1
  /^198\.51\.100\./, // documentation TEST-NET-2
  /^203\.0\.113\./, // documentation TEST-NET-3
  /^224\./, // multicast
  /^240\./, // reserved
  /^255\.255\.255\.255$/, // broadcast
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "0.0.0.0",
  "::1",
  "[::1]",
  "metadata.google.internal",
  "metadata.google",
  "169.254.169.254",
]);

const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];

const IPV6_BRACKET_STRIP = /^\[|\]$/g;
const IPV6_LINK_LOCAL = /^fe[89ab]/i;
const IPV6_UNIQUE_LOCAL = /^f[cd]/i;
const IPV6_MULTICAST = /^ff/i;
const IPV4_MAPPED_V6 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;
const BARE_IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

interface UpdateBody {
  url?: string;
  name?: string;
  events?: string[];
  active?: boolean;
}

interface WebhookRecord {
  _id: string;
  organizationId: string;
  url: string;
  name: string;
  events: string[];
  secretPrefix: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

const formatWebhook = (w: WebhookRecord) => ({
  id: w._id,
  url: w.url,
  name: w.name,
  events: w.events,
  secret_prefix: w.secretPrefix,
  active: w.active,
  created_at: new Date(w.createdAt).toISOString(),
  updated_at: new Date(w.updatedAt).toISOString(),
});

const validateUpdateBody = (body: UpdateBody): string | null => {
  if (body.url !== undefined) {
    if (typeof body.url !== "string") {
      return "url must be a string";
    }
    const urlError = validateWebhookUrl(body.url);
    if (urlError) {
      return urlError;
    }
  }
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return "name must be a string";
    }
    if (body.name.trim().length === 0) {
      return "name cannot be empty";
    }
    if (body.name.length > 255) {
      return "name must be 255 characters or less";
    }
  }
  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || body.events.length === 0) {
      return "events must be a non-empty array";
    }
    const invalid = body.events.filter((e) => !VALID_EVENTS.has(e));
    if (invalid.length > 0) {
      return `Invalid events: ${invalid.join(", ")}`;
    }
  }
  if (body.active !== undefined && typeof body.active !== "boolean") {
    return "active must be a boolean";
  }
  return null;
};

const isPrivateIPv6 = (hostname: string): boolean => {
  // Strip brackets from IPv6
  const raw = hostname.replace(IPV6_BRACKET_STRIP, "").toLowerCase();
  if (raw === "::1" || raw === "::") {
    return true;
  }
  // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast
  if (
    IPV6_LINK_LOCAL.test(raw) ||
    IPV6_UNIQUE_LOCAL.test(raw) ||
    IPV6_MULTICAST.test(raw)
  ) {
    return true;
  }
  // IPv4-mapped IPv6 ::ffff:x.x.x.x
  const v4Mapped = raw.match(IPV4_MAPPED_V6);
  if (v4Mapped?.[1]) {
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(v4Mapped[1])) {
        return true;
      }
    }
  }
  return false;
};

const validateWebhookUrl = (url: string): string | null => {
  if (url.length > 2048) {
    return "URL must be 2048 characters or less";
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL format";
  }

  if (parsed.protocol !== "https:") {
    return "URL must use HTTPS";
  }

  // Block credentials in URL (userinfo component)
  if (parsed.username || parsed.password) {
    return "URL must not contain credentials";
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block well-known dangerous hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return "URL cannot point to localhost or internal services";
  }

  // Block dangerous TLD suffixes (.local, .internal, .localhost)
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return "URL cannot point to internal hostnames";
    }
  }

  // Block private IPv4 ranges
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return "URL cannot point to private IP addresses";
    }
  }

  // Block private IPv6 ranges
  if (
    (hostname.startsWith("[") || hostname.includes(":")) &&
    isPrivateIPv6(hostname)
  ) {
    return "URL cannot point to private IP addresses";
  }

  // Block bare IP addresses entirely to mitigate DNS rebinding
  // and various numeric encoding tricks (octal, hex, decimal IPs)
  if (BARE_IPV4.test(hostname) || hostname.startsWith("[")) {
    return "URL must use a hostname, not an IP address";
  }

  return null;
};

const app = new Hono<{ Bindings: Env }>();

app.post(
  "/:orgId/webhooks",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    let body: { url: string; name: string; events: string[] };
    try {
      body = await c.req.json<{
        url: string;
        name: string;
        events: string[];
      }>();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const { url, name, events } = body;

    if (!url || typeof url !== "string" || url.trim().length === 0) {
      return c.json({ error: "url is required and must be a string" }, 400);
    }

    const urlError = validateWebhookUrl(url);
    if (urlError) {
      return c.json({ error: urlError }, 400);
    }

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return c.json({ error: "name is required and must be a string" }, 400);
    }

    if (name.length > 255) {
      return c.json({ error: "name must be 255 characters or less" }, 400);
    }

    if (!(events && Array.isArray(events)) || events.length === 0) {
      return c.json({ error: "events must be a non-empty array" }, 400);
    }

    const invalidEvents = events.filter((e) => !VALID_EVENTS.has(e));
    if (invalidEvents.length > 0) {
      return c.json(
        { error: `Invalid events: ${invalidEvents.join(", ")}` },
        400
      );
    }

    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secretBase64 = btoa(String.fromCharCode(...secretBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    const secret = `whsec_${secretBase64}`;
    const secretPrefix = secret.substring(0, 12);

    if (!c.env.ENCRYPTION_KEY) {
      return c.json({ error: "Webhook encryption not configured" }, 500);
    }

    const secretEncrypted = await encryptToken(secret, c.env.ENCRYPTION_KEY);

    const convex = getConvexClient(c.env);
    const now = Date.now();

    const webhookId = (await convex.mutation("webhooks:create", {
      organizationId: organization._id,
      url,
      name: name.trim(),
      events,
      secretEncrypted,
      secretPrefix,
      createdAt: now,
      updatedAt: now,
    })) as string;

    return c.json(
      {
        id: webhookId,
        url,
        name: name.trim(),
        events,
        secret,
        secret_prefix: secretPrefix,
        active: true,
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
      201
    );
  }
);

app.get(
  "/:orgId/webhooks",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    const convex = getConvexClient(c.env);
    const webhooks = (await convex.query("webhooks:listByOrg", {
      organizationId: organization._id,
    })) as WebhookRecord[];

    return c.json({ webhooks: webhooks.map(formatWebhook) });
  }
);

app.get(
  "/:orgId/webhooks/:webhookId",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;
    const webhookId = c.req.param("webhookId");

    const convex = getConvexClient(c.env);
    const webhook = (await convex.query("webhooks:getById", {
      id: webhookId,
    })) as WebhookRecord | null;

    if (!webhook || webhook.organizationId !== organization._id) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    return c.json({ webhook: formatWebhook(webhook) });
  }
);

app.patch(
  "/:orgId/webhooks/:webhookId",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;
    const webhookId = c.req.param("webhookId");

    let body: {
      url?: string;
      name?: string;
      events?: string[];
      active?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const validationError = validateUpdateBody(body);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    const convex = getConvexClient(c.env);

    const existing = (await convex.query("webhooks:getById", {
      id: webhookId,
    })) as WebhookRecord | null;

    if (!existing || existing.organizationId !== organization._id) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    const updateFields: Record<string, unknown> = {
      updatedAt: Date.now(),
    };
    if (body.url !== undefined) {
      updateFields.url = body.url;
    }
    if (body.name !== undefined) {
      updateFields.name = body.name.trim();
    }
    if (body.events !== undefined) {
      updateFields.events = body.events;
    }
    if (body.active !== undefined) {
      updateFields.active = body.active;
    }

    await convex.mutation("webhooks:update", {
      id: webhookId,
      ...updateFields,
    });

    return c.json({
      webhook: formatWebhook({ ...existing, ...updateFields } as WebhookRecord),
    });
  }
);

app.delete(
  "/:orgId/webhooks/:webhookId",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;
    const webhookId = c.req.param("webhookId");

    const convex = getConvexClient(c.env);

    const existing = (await convex.query("webhooks:getById", {
      id: webhookId,
    })) as WebhookRecord | null;

    if (!existing || existing.organizationId !== organization._id) {
      return c.json({ error: "Webhook not found" }, 404);
    }

    await convex.mutation("webhooks:remove", { id: webhookId });

    return c.json({ success: true, deleted_id: webhookId });
  }
);

export default app;
