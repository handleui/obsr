// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";

// Derive TransactionEvent type from Sentry SDK - avoids fragile local definition
type TransactionEvent = Parameters<
  NonNullable<Sentry.CloudflareOptions["beforeSendTransaction"]>
>[0];

import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { authMiddleware } from "./middleware/auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { sentryContextMiddleware } from "./middleware/sentry-context";
import authRoutes from "./routes/auth";
import billingRoutes from "./routes/billing";
import errorsRoutes from "./routes/errors";
import healRoutes from "./routes/heal";
import healthRoutes from "./routes/health";
import { invitationRoutes, orgInvitationsRoutes } from "./routes/invitations";
import organizationMembersRoutes from "./routes/organization-members";
import organizationsRoutes from "./routes/organizations";
import parseRoutes from "./routes/parse";
import projectsRoutes from "./routes/projects";
import webhookRoutes from "./routes/webhooks";
import polarWebhookRoutes from "./routes/webhooks/polar";
import type { Env } from "./types/env";

// Lightweight regex for scrubbing tokens from error messages
// Optimized for Cloudflare Workers CPU limits - focuses on high-risk patterns only
// Includes: GitHub tokens, Bearer tokens, Stripe keys, JWTs, Resend keys, GitLab PATs
// Additional protection via sendDefaultPii: false and Sentry server-side scrubbing
const SENSITIVE_PATTERN =
  /gh[pors]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,}|Bearer\s+[A-Za-z0-9._\-/+=]+|sk_(?:live|test)_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+|re_[A-Za-z0-9_]{32,}|glpat-[A-Za-z0-9_-]{20,}/gi;

const scrubSensitiveData = (value: string): string =>
  value.replace(SENSITIVE_PATTERN, "[REDACTED]");

// Keys that commonly contain sensitive data - filter these entirely
const SENSITIVE_KEYS =
  /password|secret|token|apikey|api_key|authorization|credential|cookie/i;

// Recursively scrub sensitive data from objects (for context, extra, breadcrumbs)
const scrubObject = (obj: unknown): unknown => {
  if (typeof obj === "string") {
    return scrubSensitiveData(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(scrubObject);
  }
  if (obj !== null && typeof obj === "object") {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      scrubbed[key] = SENSITIVE_KEYS.test(key)
        ? "[FILTERED]"
        : scrubObject(value);
    }
    return scrubbed;
  }
  return obj;
};

// Scrub breadcrumbs array
const scrubBreadcrumbs = (breadcrumbs: Sentry.Breadcrumb[]): void => {
  for (const breadcrumb of breadcrumbs) {
    if (breadcrumb.message) {
      breadcrumb.message = scrubSensitiveData(breadcrumb.message);
    }
    if (breadcrumb.data) {
      breadcrumb.data = scrubObject(breadcrumb.data) as Record<string, unknown>;
    }
  }
};

// Scrub tags object
const scrubTags = (tags: Record<string, unknown>): Record<string, string> => {
  const scrubbedTags: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    scrubbedTags[key] =
      typeof value === "string" ? scrubSensitiveData(value) : String(value);
  }
  return scrubbedTags;
};

// Scrub exception values (error messages in stack traces)
const scrubExceptions = (values: Sentry.Exception[]): void => {
  for (const exception of values) {
    if (exception.value) {
      exception.value = scrubSensitiveData(exception.value);
    }
  }
};

// Scrub common event fields (contexts, extra, tags, user)
const scrubEventFields = (event: Sentry.Event): void => {
  if (event.contexts) {
    event.contexts = scrubObject(event.contexts) as Record<
      string,
      Record<string, unknown>
    >;
  }
  if (event.extra) {
    event.extra = scrubObject(event.extra) as Record<string, unknown>;
  }
  if (event.tags) {
    event.tags = scrubTags(event.tags);
  }
};

const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use("*", logger());

// Security headers
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
    },
    xContentTypeOptions: "nosniff",
    xFrameOptions: "DENY",
    referrerPolicy: "strict-origin-when-cross-origin",
  })
);

// CORS configuration - restrict to allowed origins
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) {
        return null;
      }

      // Allow localhost for development
      if (
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")
      ) {
        return origin;
      }

      // Allow configured allowed origins
      const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(",") ?? [];
      if (allowedOrigins.includes(origin)) {
        return origin;
      }

      // Deny all other origins
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: [
      "Content-Length",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ],
    maxAge: 86_400,
    credentials: true,
  })
);

// Sentry context enrichment (request ID, delivery ID, breadcrumbs)
app.use("*", sentryContextMiddleware);

// Public routes
app.get("/", (c) => c.text("detent api"));
app.route("/health", healthRoutes);

// Webhook routes (verified by signature, not API key)
app.route("/webhooks", webhookRoutes);
app.route("/webhooks/polar", polarWebhookRoutes);

// Protected routes (require JWT auth + rate limiting)
const api = new Hono<{ Bindings: Env }>();
api.use("*", authMiddleware);
api.use("*", rateLimitMiddleware);
api.route("/auth", authRoutes);
api.route("/errors", errorsRoutes);
api.route("/parse", parseRoutes);
api.route("/heal", healRoutes);
api.route("/projects", projectsRoutes);
api.route("/organization-members", organizationMembersRoutes);
api.route("/organizations", organizationsRoutes);
api.route("/invitations", invitationRoutes);
api.route("/orgs/:orgId/invitations", orgInvitationsRoutes);
api.route("/billing", billingRoutes);

app.route("/v1", api);

// Export type for potential RPC client
export type AppType = typeof app;

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    tracesSampleRate: 0.05, // MVP: 5% traces
    sampleRate: 1.0, // 100% errors
    sendDefaultPii: false, // Explicit: never send IP addresses, cookies, etc.
    // Lightweight beforeSend using helper functions for CF Workers CPU limits
    beforeSend: (event: Sentry.ErrorEvent) => {
      if (event.message) {
        event.message = scrubSensitiveData(event.message);
      }
      if (event.exception?.values) {
        scrubExceptions(event.exception.values);
      }
      if (event.breadcrumbs) {
        scrubBreadcrumbs(event.breadcrumbs);
      }
      scrubEventFields(event);
      // Keep user.id only (internal IDs are safe)
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : {};
      }
      return event;
    },
    // Lighter scrubbing for transactions (5% sample rate = less critical)
    beforeSendTransaction: (event: TransactionEvent) => {
      if (event.breadcrumbs) {
        scrubBreadcrumbs(event.breadcrumbs);
      }
      scrubEventFields(event);
      return event;
    },
  }),
  app
);
