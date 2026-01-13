import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/nextjs";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK requires namespace import pattern
import * as Sentry from "@sentry/nextjs";
import { scrubObject, scrubString } from "./src/lib/scrub";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/**
 * Scrub sensitive data from Sentry events before sending
 */
const beforeSend = (event: ErrorEvent, _hint: EventHint): ErrorEvent | null => {
  // Scrub URL data
  if (event.request?.url) {
    event.request.url = scrubString(event.request.url);
  }
  if (event.request?.query_string) {
    event.request.query_string = scrubString(
      typeof event.request.query_string === "string"
        ? event.request.query_string
        : String(event.request.query_string)
    );
  }

  // Scrub headers (remove sensitive ones entirely)
  if (event.request?.headers) {
    const safeHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(event.request.headers)) {
      const lowerKey = key.toLowerCase();
      if (
        !(
          lowerKey.includes("authorization") ||
          lowerKey.includes("cookie") ||
          lowerKey.includes("token")
        )
      ) {
        safeHeaders[key] = typeof value === "string" ? scrubString(value) : "";
      }
    }
    event.request.headers = safeHeaders;
  }

  // Scrub breadcrumbs
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb: Breadcrumb) => {
      if (breadcrumb.message) {
        breadcrumb.message = scrubString(breadcrumb.message);
      }
      if (breadcrumb.data) {
        breadcrumb.data = scrubObject(
          breadcrumb.data as Record<string, unknown>
        );
      }
      return breadcrumb;
    });
  }

  // Scrub extra context
  if (event.extra) {
    event.extra = scrubObject(event.extra);
  }

  // Scrub tags
  if (event.tags) {
    event.tags = scrubObject(event.tags) as Record<string, string>;
  }

  // Remove user PII if present (keep only anonymized user ID)
  if (event.user) {
    event.user.email = undefined;
    event.user.username = undefined;
    event.user.ip_address = undefined;
  }

  return event;
};

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === "production",

    // SECURITY: Disable automatic PII collection (IP addresses, cookies, etc.)
    // We use beforeSend to scrub any sensitive data that might slip through
    sendDefaultPii: false,

    // Sample rates for performance and cost management
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.25,
    sampleRate: 1.0, // Send all errors (can be reduced if volume is too high)

    // Session replay sample rates
    // Replay integration is lazy-loaded below to not block initial page load
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    integrations: [
      // Capture failed HTTP requests (fetch/XHR) as Sentry errors
      Sentry.httpClientIntegration(),
      // Capture browser API errors (e.g., WebSocket, IndexedDB)
      Sentry.browserApiErrorsIntegration(),
      // Replay integration is added lazily after page load for better performance
    ],

    // SECURITY: Scrub sensitive data before sending to Sentry
    beforeSend,

    // Filter out common noise errors that don't need tracking
    ignoreErrors: [
      // Browser extensions
      /extensions\//i,
      /^chrome-extension:\/\//i,
      /^moz-extension:\/\//i,
      // Network errors (often transient)
      "Network request failed",
      "Failed to fetch",
      "Load failed",
      // User-triggered navigation
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
    ],
  });

  // Lazy-load Session Replay after initial page load to reduce bundle size impact
  // and avoid blocking the critical rendering path
  if (typeof window !== "undefined") {
    const loadReplay = () => {
      import("@sentry/nextjs").then((lazyLoadedSentry) => {
        Sentry.addIntegration(
          lazyLoadedSentry.replayIntegration({
            // SECURITY: Mask all text content by default for privacy
            maskAllText: true,
            // SECURITY: Mask all form inputs to prevent capturing sensitive data
            maskAllInputs: true,
            // SECURITY: Block all media to prevent capturing sensitive images/videos
            blockAllMedia: true,
            // Additional selectors to mask (forms, auth elements)
            mask: [
              ".sentry-mask",
              "[data-sentry-mask]",
              'input[type="password"]',
              'input[type="email"]',
              'input[name*="token"]',
              'input[name*="secret"]',
              'input[name*="password"]',
              'input[name*="api"]',
              "[data-sensitive]",
            ],
            // Block entire sections that should not be recorded
            block: [
              ".sentry-block",
              "[data-sentry-block]",
              "[data-private]",
              ".auth-form",
              ".payment-form",
            ],
          })
        );
      });
    };

    // Use requestIdleCallback for non-blocking initialization, with setTimeout fallback
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(loadReplay, { timeout: 5000 });
    } else {
      // Fallback for Safari and older browsers
      setTimeout(loadReplay, 2000);
    }
  }
}
