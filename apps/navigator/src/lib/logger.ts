// biome-ignore lint/performance/noBarrelFile: Re-exports needed for external consumers
export {
  type BetterStackRequest,
  Logger,
  LogLevel,
  withBetterStackRouteHandler,
} from "@logtail/next";

import type { BetterStackRequest } from "@logtail/next";
import { Logger, withBetterStackRouteHandler } from "@logtail/next";
import { captureException } from "@sentry/nextjs";
import type { NextResponse } from "next/server";
import { scrubObject, scrubString } from "./scrub";

/**
 * Sanitize metadata before logging
 * SECURITY: Wrapper to ensure all logged metadata is scrubbed
 */
const sanitizeMetadata = (
  metadata: Record<string, unknown>
): Record<string, unknown> => {
  return scrubObject(metadata);
};

export const createLogger = (source?: string) =>
  new Logger(source ? { source } : undefined);

type RouteHandler = (
  req: BetterStackRequest,
  context?: unknown
) => Promise<Response | NextResponse> | Response | NextResponse;

/**
 * Wrap a route handler with Better Stack logging.
 * Automatically logs request details, duration, and errors.
 */
export const withLogging = (handler: RouteHandler, source?: string) =>
  withBetterStackRouteHandler(
    (req: BetterStackRequest, context?: unknown) => {
      if (source) {
        req.log = req.log.with({ source });
      }
      return handler(req, context);
    },
    { logRequestDetails: true }
  );

/**
 * Log a server action execution with automatic error capture.
 * Use in server actions for consistent logging.
 * Success path flushes synchronously to ensure logs are persisted.
 * Error path flushes asynchronously to avoid blocking error propagation.
 *
 * SECURITY: Metadata is automatically scrubbed before logging.
 */
export const logServerAction = async <T>(
  actionName: string,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> => {
  const log = createLogger("server-action");
  const startTime = Date.now();
  // SECURITY: Scrub metadata before logging
  const safeMetadata = sanitizeMetadata(metadata);

  try {
    log.info(`${actionName} started`, { action: actionName, ...safeMetadata });
    const result = await fn();
    const duration = Date.now() - startTime;
    log.info(`${actionName} completed`, {
      action: actionName,
      durationMs: duration,
      ...safeMetadata,
    });
    await log.flush();
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error instanceof Error) {
      captureException(error, {
        tags: { action: actionName },
        // SECURITY: Don't pass raw metadata to Sentry, only duration
        extra: { durationMs: duration },
      });
    }

    log.error(`${actionName} failed`, {
      action: actionName,
      durationMs: duration,
      // SECURITY: Scrub error message before logging
      error:
        error instanceof Error ? scrubString(error.message) : String(error),
      // SECURITY: Don't log full stack traces to Better Stack (they go to Sentry)
      ...safeMetadata,
    });

    // Flush asynchronously to avoid blocking error propagation
    // Errors are already captured by Sentry above
    // biome-ignore lint/suspicious/noEmptyBlockStatements: Intentional no-op for fire-and-forget
    log.flush().catch(() => {});
    throw error;
  }
};

/**
 * Structured error logging helper for consistent error reporting.
 * Reports to both Better Stack logs and Sentry error tracking.
 * Flushes logs asynchronously to avoid blocking user interactions.
 *
 * SECURITY: Context is automatically scrubbed before logging.
 */
export const logError = (
  source: string,
  error: Error,
  context?: Record<string, unknown>
) => {
  // SECURITY: Scrub context before logging
  const safeContext = context ? sanitizeMetadata(context) : undefined;

  captureException(error, {
    tags: { source },
    // SECURITY: Sentry gets the scrubbed context
    extra: safeContext,
  });

  const log = createLogger(source);
  log.error(scrubString(error.message), {
    errorName: error.name,
    // SECURITY: Don't log full stack traces to Better Stack
    // SECURITY: Don't log error.cause as it may contain sensitive data
    ...safeContext,
  });

  // Flush asynchronously to avoid blocking the caller
  // This is fire-and-forget; errors are already captured by Sentry above
  // biome-ignore lint/suspicious/noEmptyBlockStatements: Intentional no-op for fire-and-forget
  log.flush().catch(() => {});
};
