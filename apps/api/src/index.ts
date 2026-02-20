import { scrubEvent } from "@detent/sentry";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";

type TransactionEvent = Parameters<
  NonNullable<Sentry.CloudflareOptions["beforeSendTransaction"]>
>[0];

import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { apiKeyRateLimitMiddleware } from "./middleware/api-key-rate-limit";
import { authMiddleware } from "./middleware/auth";
import { combinedAuthMiddleware } from "./middleware/combined-auth";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { sentryContextMiddleware } from "./middleware/sentry-context";
import apiKeysRoutes from "./routes/api-keys";
import authRoutes from "./routes/auth";
import autofixResultRoutes from "./routes/autofix-result";
import billingRoutes from "./routes/billing";
import errorsRoutes from "./routes/errors";
import githubSecretsRoutes from "./routes/github-secrets";
import healRoutes from "./routes/heal";
import healthRoutes from "./routes/health";
import { invitationRoutes, orgInvitationsRoutes } from "./routes/invitations";
import orgWebhooksRoutes from "./routes/org-webhooks";
import organizationMembersRoutes from "./routes/organization-members";
import organizationsRoutes from "./routes/organizations";
import orgsByProviderRoutes from "./routes/orgs-by-provider";
import projectsRoutes from "./routes/projects";
import webhookRoutes from "./routes/webhooks";
import polarWebhookRoutes from "./routes/webhooks/polar";
import type { Env } from "./types/env";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());

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

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      if (!origin) {
        return null;
      }

      if (
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")
      ) {
        return origin;
      }

      const allowedOrigins = c.env.ALLOWED_ORIGINS?.split(",") ?? [];
      if (allowedOrigins.includes(origin)) {
        return origin;
      }

      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Detent-Token",
      "X-GitHub-Token",
    ],
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

app.use("*", sentryContextMiddleware);

app.get("/", (c) => c.text("detent api"));
app.route("/health", healthRoutes);
app.route("/webhooks", webhookRoutes);
app.route("/webhooks/polar", polarWebhookRoutes);
app.route("/v1/heal/autofix-result", autofixResultRoutes);

// External API: accepts both JWT and API key auth (for SDK/CI consumers)
const externalApi = new Hono<{ Bindings: Env }>();
externalApi.use("*", combinedAuthMiddleware);
externalApi.use("*", (c, next) => {
  if (c.get("apiKeyAuth")) {
    return apiKeyRateLimitMiddleware(c, next);
  }
  return rateLimitMiddleware(c, next);
});
externalApi.route("/errors", errorsRoutes);
app.route("/v1", externalApi);

// Internal API: JWT only
const api = new Hono<{ Bindings: Env }>();
api.use("*", authMiddleware);
api.use("*", rateLimitMiddleware);
api.route("/auth", authRoutes);
api.route("/heal", healRoutes);
api.route("/projects", projectsRoutes);
api.route("/organization-members", organizationMembersRoutes);
api.route("/organizations", organizationsRoutes);
api.route("/invitations", invitationRoutes);
api.route("/orgs/:orgId/invitations", orgInvitationsRoutes);
api.route("/orgs", apiKeysRoutes);
api.route("/orgs", orgWebhooksRoutes);
api.route("/orgs", githubSecretsRoutes);
api.route("/orgs", orgsByProviderRoutes);
api.route("/billing", billingRoutes);

app.route("/v1", api);

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
    tracesSampleRate: 0.05,
    sampleRate: 1.0,
    sendDefaultPii: false,
    beforeSend: (event: Sentry.ErrorEvent) => {
      scrubEvent(event);
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : {};
      }
      return event;
    },
    beforeSendTransaction: (event: TransactionEvent) => {
      scrubEvent(event);
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : {};
      }
      return event;
    },
  }),
  worker
);
