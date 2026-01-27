import { scrubEvent } from "@detent/sentry";
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
import apiKeysRoutes from "./routes/api-keys";
import authRoutes from "./routes/auth";
import autofixResultRoutes from "./routes/autofix-result";
import billingRoutes from "./routes/billing";
import diagnosticsRoutes from "./routes/diagnostics";
import errorsRoutes from "./routes/errors";
import githubSecretsRoutes from "./routes/github-secrets";
import healRoutes from "./routes/heal";
import healthRoutes from "./routes/health";
import { invitationRoutes, orgInvitationsRoutes } from "./routes/invitations";
import organizationMembersRoutes from "./routes/organization-members";
import organizationsRoutes from "./routes/organizations";
import orgsByProviderRoutes from "./routes/orgs-by-provider";
import projectsRoutes from "./routes/projects";
import reportRoutes from "./routes/report";
import webhookRoutes from "./routes/webhooks";
import polarWebhookRoutes from "./routes/webhooks/polar";
import type { Env } from "./types/env";

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
    allowHeaders: ["Content-Type", "Authorization", "X-Detent-Token"],
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

// API key authenticated routes (X-Detent-Token header)
app.route("/report", reportRoutes);
app.route("/v1/heal/autofix-result", autofixResultRoutes);

// Protected routes (require JWT auth + rate limiting)
const api = new Hono<{ Bindings: Env }>();
api.use("*", authMiddleware);
api.use("*", rateLimitMiddleware);
api.route("/auth", authRoutes);
api.route("/errors", errorsRoutes);
api.route("/heal", healRoutes);
api.route("/projects", projectsRoutes);
api.route("/organization-members", organizationMembersRoutes);
api.route("/organizations", organizationsRoutes);
api.route("/invitations", invitationRoutes);
api.route("/orgs/:orgId/invitations", orgInvitationsRoutes);
api.route("/orgs", apiKeysRoutes);
api.route("/orgs", githubSecretsRoutes);
api.route("/orgs", orgsByProviderRoutes);
api.route("/billing", billingRoutes);

app.route("/v1", api);

// Public diagnostics endpoint (no auth - used by SDK fallback)
// Mounted at root because the OpenAPIHono route defines full path for accurate spec generation
app.route("/", diagnosticsRoutes);

// OpenAPI spec - generated once at module load time, not per request
const openApiSpec = diagnosticsRoutes.getOpenAPIDocument({
  openapi: "3.1.0",
  info: {
    title: "Detent API",
    version: "1.0.0",
    description:
      "Self-healing CI/CD platform. Parse CI logs, match error patterns, and trigger AI fixes.",
  },
  servers: [
    { url: "https://backend.detent.sh", description: "Production" },
    { url: "http://localhost:8787", description: "Local development" },
  ],
});

app.get("/openapi.json", (c) => c.json(openApiSpec));

// Export type for potential RPC client
export type AppType = typeof app;

const worker: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  async scheduled(_event, env, ctx) {
    const { syncAllOrganizations } = await import("./jobs/sync-organizations");
    const { cleanupStaleHeals } = await import("./jobs/cleanup-stale-heals");

    ctx.waitUntil(
      Promise.all([
        syncAllOrganizations(env).catch((err) => {
          console.error("[scheduled] Sync failed:", err);
          Sentry.captureException(err);
        }),
        cleanupStaleHeals(env).catch((err) => {
          console.error("[scheduled] Cleanup stale heals failed:", err);
          Sentry.captureException(err);
        }),
      ])
    );
  },
};

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    tracesSampleRate: 0.05, // MVP: 5% traces
    sampleRate: 1.0, // 100% errors
    sendDefaultPii: false, // Explicit: never send IP addresses, cookies, etc.
    beforeSend: (event: Sentry.ErrorEvent) => {
      scrubEvent(event);
      // Keep user.id only (internal IDs are safe)
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : {};
      }
      return event;
    },
    beforeSendTransaction: (event: TransactionEvent) => {
      scrubEvent(event);
      // Keep user.id only (internal IDs are safe, email/username/ip_address are PII)
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : {};
      }
      return event;
    },
  }),
  worker
);
