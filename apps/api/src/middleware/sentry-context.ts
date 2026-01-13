/**
 * Sentry context enrichment middleware
 *
 * Sets request-level context for Sentry error tracking:
 * - Request ID (CF-Ray or generated UUID)
 * - GitHub delivery ID (for webhook correlation)
 * - HTTP request breadcrumb
 *
 * Note on scope isolation:
 * In @sentry/cloudflare with withSentry() wrapper, these global setTag/addBreadcrumb
 * calls are automatically scoped to the current request via AsyncLocalStorage.
 * The SDK forks the scope for each request, so tags set here won't leak between
 * concurrent requests. See: https://docs.sentry.io/platforms/javascript/enriching-events/scopes/
 */

// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import type { Context, Next } from "hono";
import type { Env } from "../types/env";

export const sentryContextMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<void> => {
  // Use Cloudflare Ray ID for request tracing, fallback to UUID
  const requestId = c.req.header("CF-Ray") ?? crypto.randomUUID();
  const deliveryId = c.req.header("X-GitHub-Delivery");

  // Tags are searchable in Sentry UI - use for filterable dimensions
  Sentry.setTag("request.id", requestId);
  if (deliveryId) {
    Sentry.setTag("github.delivery_id", deliveryId);
  }

  // Add request breadcrumb for error context
  // Breadcrumbs show the path leading to an error in Sentry event detail
  Sentry.addBreadcrumb({
    category: "http",
    message: `${c.req.method} ${c.req.path}`,
    level: "info",
  });

  await next();
};
