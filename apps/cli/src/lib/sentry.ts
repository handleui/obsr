/**
 * Sentry error monitoring for Detent CLI
 *
 * Optimized for CLI performance:
 * - Lazy SDK loading to avoid startup overhead when not needed
 * - Minimal integrations (no HTTP/server tracing)
 * - Explicit flush before exit to ensure events are sent
 */

import { isProduction } from "./env.js";

// Lazily loaded Sentry module
let Sentry: typeof import("@sentry/node") | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize Sentry SDK for CLI error tracking.
 * Lazy loads the SDK to avoid startup overhead for simple commands.
 * Returns a promise that resolves when initialization is complete.
 */
export const initSentry = (): Promise<void> => {
  if (initialized) {
    return Promise.resolve();
  }
  if (initPromise) {
    return initPromise;
  }

  const dsn = process.env.SENTRY_DSN;
  const enabled = isProduction() || process.env.SENTRY_DEBUG === "true";

  if (!(dsn && enabled)) {
    // No DSN or not enabled - mark as initialized to skip future calls
    initialized = true;
    return Promise.resolve();
  }

  initPromise = (async () => {
    const { getVersion } = await import("../utils/version.js");
    Sentry = await import("@sentry/node");

    // Use initWithoutDefaultIntegrations for minimal overhead
    // CLI apps don't need HTTP tracing, server integrations, etc.
    Sentry.initWithoutDefaultIntegrations({
      dsn,
      release: `detent-cli@${getVersion()}`,
      environment: isProduction() ? "production" : "development",
      // Error events only - no performance tracing for CLI
      tracesSampleRate: 0,
      // Capture 100% of errors in production
      sampleRate: 1.0,
      integrations: [
        // Core integrations for error handling
        Sentry.dedupeIntegration(),
        Sentry.inboundFiltersIntegration(),
        Sentry.linkedErrorsIntegration(),
        Sentry.functionToStringIntegration(),
        // Console breadcrumbs are useful for CLI debugging
        Sentry.consoleIntegration(),
      ],
      // Add CLI-specific context
      initialScope: (scope) => {
        scope.setTag("app", "cli");
        scope.setTag("node.version", process.version);
        scope.setTag("platform", process.platform);
        scope.setTag("arch", process.arch);
        return scope;
      },
      // Filter out known non-actionable errors
      beforeSend: (event) => {
        // Don't report user-initiated exits
        if (event.exception?.values?.[0]?.type === "ExitError") {
          return null;
        }
        return event;
      },
    });

    initialized = true;
  })();

  return initPromise;
};

/**
 * Capture an exception with optional context.
 * Safe to call even if Sentry is not initialized.
 */
export const captureException = (
  error: unknown,
  context?: Record<string, unknown>
): void => {
  if (!(initialized && Sentry)) {
    return;
  }

  const sdk = Sentry;
  if (context) {
    sdk.withScope((scope) => {
      scope.setContext("cli", context);
      sdk.captureException(error);
    });
  } else {
    sdk.captureException(error);
  }
};

/**
 * Set user context for error attribution.
 * Call after authentication to track errors by user.
 */
export const setUser = (userId: string | null): void => {
  if (!(initialized && Sentry)) {
    return;
  }
  Sentry.setUser(userId ? { id: userId } : null);
};

/**
 * Add a breadcrumb for debugging error context.
 */
export const addBreadcrumb = (
  message: string,
  data?: Record<string, unknown>
): void => {
  if (!(initialized && Sentry)) {
    return;
  }
  Sentry.addBreadcrumb({
    category: "cli",
    message,
    data,
    level: "info",
  });
};

/**
 * Flush pending events before exit.
 * CLI apps exit quickly - without flushing, events may be lost.
 * Call this before process.exit() to ensure events are sent.
 *
 * @param timeout - Maximum time to wait in ms (default: 2000)
 * @returns true if events were flushed successfully
 */
export const flush = (timeout = 2000): Promise<boolean> => {
  if (!(initialized && Sentry)) {
    return Promise.resolve(true);
  }
  return Sentry.flush(timeout);
};
