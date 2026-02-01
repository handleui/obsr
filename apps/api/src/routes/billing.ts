import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  requireRole,
} from "../middleware/github-org-access";
import { getCreditUsageSummary, getUsageSummary } from "../services/billing";
import {
  createCustomerPortalSession,
  createPolarClient,
  createPolarCustomer,
  getPolarOrgId,
} from "../services/polar";
import type { Env } from "../types/env";

// ============================================================================
// Constants
// ============================================================================

const LOG_PREFIX = "[billing]";

// Email validation regex (RFC 5322 simplified)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 255;

// ============================================================================
// Validation Helpers
// ============================================================================

const isValidEmail = (email: unknown): email is string =>
  typeof email === "string" &&
  email.length <= MAX_EMAIL_LENGTH &&
  EMAIL_REGEX.test(email);

const isValidName = (name: unknown): name is string | undefined =>
  name === undefined ||
  (typeof name === "string" && name.length <= MAX_NAME_LENGTH);

const isValidSuccessUrl = (url: unknown): url is string | undefined => {
  if (url === undefined) {
    return true;
  }
  if (typeof url !== "string") {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1"
    );
  } catch {
    return false;
  }
};

// ============================================================================
// Routes
// ============================================================================

const app = new Hono<{ Bindings: Env }>();

// POST /billing/:orgId/customer - Create Polar customer for org
// SECURITY: Requires owner/admin role to create billing customer
app.post(
  "/:orgId/customer",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }

    const { email, name } = body as Record<string, unknown>;

    if (!isValidEmail(email)) {
      return c.json({ error: "Valid email is required" }, 400);
    }

    if (!isValidName(name)) {
      return c.json(
        { error: "Name must be a string under 255 characters" },
        400
      );
    }

    try {
      const convex = getConvexClient(c.env);
      const org = (await convex.query("organizations:getById", {
        id: organization._id,
      })) as { polarCustomerId?: string | null } | null;

      if (!org) {
        return c.json({ error: "Organization not found" }, 404);
      }

      if (org.polarCustomerId) {
        return c.json(
          { error: "Organization already has a billing customer" },
          400
        );
      }

      const polar = createPolarClient(c.env);
      const polarOrgId = getPolarOrgId(c.env);

      const customer = await createPolarCustomer(
        polar,
        polarOrgId,
        organization._id,
        email,
        name
      );

      await convex.mutation("organizations:update", {
        id: organization._id,
        polarCustomerId: customer.id,
        updatedAt: Date.now(),
      });

      return c.json({ customerId: customer.id });
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to create Polar customer:`, error);
      return c.json({ error: "Failed to create billing customer" }, 500);
    }
  }
);

// GET /billing/:orgId/usage - Get usage summary (run stats)
// SECURITY: Any org member can view usage
app.get("/:orgId/usage", githubOrgAccessMiddleware, async (c) => {
  const orgAccess = c.get("orgAccess") as OrgAccessContext;
  const { organization } = orgAccess;

  try {
    const summary = await getUsageSummary(c.env, organization._id);
    return c.json(summary);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to get usage summary:`, error);
    return c.json({ error: "Failed to get usage" }, 500);
  }
});

// GET /billing/:orgId/credits - Get credit usage breakdown (AI vs sandbox)
// SECURITY: Any org member can view credits
app.get("/:orgId/credits", githubOrgAccessMiddleware, async (c) => {
  const orgAccess = c.get("orgAccess") as OrgAccessContext;
  const { organization } = orgAccess;

  try {
    const summary = await getCreditUsageSummary(c.env, organization._id);
    return c.json(summary);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to get credit usage:`, error);
    return c.json({ error: "Failed to get credits" }, 500);
  }
});

// POST /billing/:orgId/checkout - Create checkout session
// SECURITY: Requires owner/admin role to initiate checkout
app.post(
  "/:orgId/checkout",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Request body must be a JSON object" }, 400);
    }

    const { productId, successUrl, customerEmail, allowDiscountCodes } =
      body as Record<string, unknown>;

    if (typeof productId !== "string" || productId.length === 0) {
      return c.json({ error: "productId is required" }, 400);
    }

    if (!isValidSuccessUrl(successUrl)) {
      return c.json({ error: "successUrl must be a valid HTTPS URL" }, 400);
    }

    if (customerEmail !== undefined && !isValidEmail(customerEmail)) {
      return c.json({ error: "customerEmail must be a valid email" }, 400);
    }

    if (
      allowDiscountCodes !== undefined &&
      typeof allowDiscountCodes !== "boolean"
    ) {
      return c.json({ error: "allowDiscountCodes must be a boolean" }, 400);
    }

    try {
      const convex = getConvexClient(c.env);
      const org = (await convex.query("organizations:getById", {
        id: organization._id,
      })) as { polarCustomerId?: string | null } | null;

      if (!org) {
        return c.json({ error: "Organization not found" }, 404);
      }

      const polar = createPolarClient(c.env);

      const checkout = await polar.checkouts.create({
        products: [productId],
        successUrl,
        allowDiscountCodes: allowDiscountCodes ?? true,
        metadata: {
          detentOrgId: organization._id,
        },
        ...(org.polarCustomerId ? { customerId: org.polarCustomerId } : {}),
        ...(customerEmail ? { customerEmail } : {}),
      });

      return c.json({ checkoutUrl: checkout.url });
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to create checkout:`, error);
      return c.json({ error: "Failed to create checkout" }, 500);
    }
  }
);

// GET /billing/:orgId/portal - Get Polar customer portal URL
// SECURITY: Requires owner/admin role to access billing portal
app.get(
  "/:orgId/portal",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    try {
      const convex = getConvexClient(c.env);
      const org = (await convex.query("organizations:getById", {
        id: organization._id,
      })) as { polarCustomerId?: string | null } | null;

      if (!org) {
        return c.json({ error: "Organization not found" }, 404);
      }

      if (!org.polarCustomerId) {
        return c.json({ error: "No billing customer configured" }, 400);
      }

      const polar = createPolarClient(c.env);
      const portalUrl = await createCustomerPortalSession(
        polar,
        org.polarCustomerId
      );

      return c.json({ portalUrl });
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to create portal session:`, error);
      return c.json({ error: "Failed to create portal session" }, 500);
    }
  }
);

export default app;
