// Sentry utilities for structured error tracking
// Integrates with existing ERROR_CODES classification system
//
// Architecture notes (@sentry/cloudflare with Hono):
// - withSentry() wrapper in index.ts handles request isolation automatically
// - Use withScope() for event-specific context to avoid cross-request leakage
// - Tags are searchable in Sentry UI; context is for debugging details
// - Fingerprints control error grouping for actionable alerts
//
// Fingerprinting strategy:
// - Aggregate errors: Group by [errorCode, eventType] only to see system-wide impact
// - Repo-specific errors: Group by [errorCode, eventType, repository] for per-repo debugging

type UnknownPatternReporter = (patterns: string[]) => void;

// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";

/**
 * Error codes that should aggregate across all repositories.
 * These represent infrastructure or system-wide issues where seeing the total
 * impact across all repos is more valuable than per-repo grouping.
 *
 * Examples:
 * - WEBHOOK_UNKNOWN_ERROR: Generic catchall - aggregate to spot trends
 * - WEBHOOK_DB_CONNECTION: Database issues affect everyone
 * - WEBHOOK_GITHUB_RATE_LIMIT: Rate limits are system-wide concerns
 * - WEBHOOK_GITHUB_API_ERROR: General GitHub API issues
 */
const AGGREGATE_ERROR_CODES = new Set([
  "WEBHOOK_UNKNOWN_ERROR",
  "WEBHOOK_DB_CONNECTION",
  "WEBHOOK_GITHUB_RATE_LIMIT",
  "WEBHOOK_GITHUB_API_ERROR",
]);

/**
 * Determine if an error code should aggregate across repositories.
 * Aggregate errors omit repository from fingerprint to show system-wide impact.
 *
 * @param errorCode - The error code to check
 * @returns true if the error should aggregate across repos
 */
export const isAggregateError = (errorCode: string): boolean =>
  AGGREGATE_ERROR_CODES.has(errorCode);

/**
 * Build fingerprint array for Sentry error grouping.
 * - Aggregate errors: [errorCode, eventType] - shows system-wide impact
 * - Repo-specific errors: [errorCode, eventType, repository] - per-repo debugging
 *
 * @param errorCode - Machine-readable error code
 * @param eventType - GitHub webhook event type
 * @param repository - Repository full name (owner/repo)
 * @returns Fingerprint array for Sentry grouping
 */
export const buildFingerprint = (
  errorCode: string,
  eventType: string,
  repository?: string
): string[] => {
  const baseFingerprint = [errorCode, eventType];

  if (isAggregateError(errorCode)) {
    return baseFingerprint;
  }

  return [...baseFingerprint, repository ?? "unknown"];
};

export interface WebhookErrorContext {
  eventType: string;
  deliveryId: string;
  repository?: string;
  installationId?: number;
  prNumber?: number;
  workflowName?: string;
  runId?: number;
}

export interface LockConflictContext {
  lockType: "pr_comment" | "commit" | "heal_creation";
  repository: string;
  prNumber?: number;
  deliveryId: string;
  operation: string;
  holderInfo?: {
    lockId: string;
    timestamp: number;
    ageMs: number;
  };
}

export interface ParserContext {
  logBytes: number;
  jobCount: number;
  errorCount: number;
  parsersAvailable: string[];
  detectedUnsupportedTools?: string[];
  // Index signature required for Sentry.setContext() compatibility
  [key: string]: unknown;
}

/**
 * Capture a webhook processing error with structured context.
 * Uses withScope() for isolation to prevent context leaking between requests.
 *
 * @param error - The original error
 * @param errorCode - Machine-readable error code from classifyError()
 * @param context - Webhook context for debugging
 * @param parserContext - Optional parser metadata (set via setParserContext before calling)
 */
export const captureWebhookError = (
  error: unknown,
  errorCode: string,
  context: WebhookErrorContext,
  parserContext?: ParserContext
): void => {
  Sentry.withScope((scope) => {
    // Use configurable fingerprinting strategy:
    // - Aggregate errors (DB, rate limit, unknown): group across all repos
    // - Repo-specific errors: include repository for per-repo debugging
    scope.setFingerprint(
      buildFingerprint(errorCode, context.eventType, context.repository)
    );

    // Tags are searchable in Sentry UI - use for filterable dimensions
    scope.setTag("error.code", errorCode);
    scope.setTag("webhook.event", context.eventType);
    if (context.repository) {
      scope.setTag("github.repository", context.repository);
    }
    if (context.deliveryId) {
      scope.setTag("github.delivery_id", context.deliveryId);
    }
    if (context.installationId) {
      scope.setTag("github.installation_id", String(context.installationId));
    }

    // Context provides debugging details (not searchable but visible in event)
    scope.setContext("webhook", {
      prNumber: context.prNumber,
      workflowName: context.workflowName,
      runId: context.runId,
    });

    // Include parser context if available
    if (parserContext) {
      scope.setContext("parser", parserContext);
    }

    Sentry.captureException(error);
  });
};

/**
 * Capture a lock conflict event for observability.
 * These are not errors per se, but indicate potential race conditions or
 * contention that may lead to inconsistent state (e.g., PR comment not updated).
 *
 * Uses warning level since the system is still functional, but the user
 * may see inconsistent state (check run shows results but comment doesn't).
 *
 * @param context - Lock conflict context for debugging
 */
export const captureLockConflict = (context: LockConflictContext): void => {
  Sentry.withScope((scope) => {
    // Group by lock type, operation, and repository
    scope.setFingerprint([
      "lock_conflict",
      context.lockType,
      context.operation,
      context.repository,
    ]);

    scope.setLevel("warning");

    // Tags for searching/filtering
    scope.setTag("lock.type", context.lockType);
    scope.setTag("lock.operation", context.operation);
    scope.setTag("github.repository", context.repository);
    scope.setTag("github.delivery_id", context.deliveryId);
    if (context.prNumber) {
      scope.setTag("github.pr_number", String(context.prNumber));
    }

    // Context for debugging
    scope.setContext("lock_conflict", {
      lockType: context.lockType,
      operation: context.operation,
      repository: context.repository,
      prNumber: context.prNumber,
      deliveryId: context.deliveryId,
      holderLockId: context.holderInfo?.lockId,
      holderAgeMs: context.holderInfo?.ageMs,
      holderTimestamp: context.holderInfo?.timestamp
        ? new Date(context.holderInfo.timestamp).toISOString()
        : undefined,
    });

    Sentry.captureMessage(
      `Lock conflict: ${context.lockType} lock not acquired for ${context.operation}`,
      { level: "warning" }
    );
  });
};

/**
 * Create a reporter callback for parser unknown patterns.
 * Called when the generic fallback parser matches an error that no
 * specific parser could handle - indicates a gap in parser coverage.
 *
 * @returns UnknownPatternReporter callback for setUnknownPatternReporter()
 */
export const createUnknownPatternReporter =
  (): UnknownPatternReporter => (patterns: string[]) => {
    if (patterns.length === 0) {
      return;
    }

    Sentry.withScope((scope) => {
      scope.setTag("parser.unknown_patterns", "true");
      scope.setLevel("warning");
      // Group all unknown pattern reports together
      scope.setFingerprint(["parser", "unknown_patterns"]);

      Sentry.captureMessage(
        `Unknown error patterns detected (${patterns.length})`,
        {
          extra: {
            // Patterns are already sanitized by parser's sanitizeForTelemetry()
            patterns: patterns.slice(0, 10),
            count: patterns.length,
          },
        }
      );
    });
  };

/**
 * Add a breadcrumb for workflow processing milestones.
 * Breadcrumbs appear in Sentry error reports showing the path to failure.
 *
 * Note: In Cloudflare Workers with withSentry(), breadcrumbs are automatically
 * scoped to the current request context, so global addBreadcrumb is safe here.
 *
 * @param action - Description of the action (e.g., "Fetched workflow logs")
 * @param data - Optional metadata
 */
export const addWorkflowBreadcrumb = (
  action: string,
  data?: Record<string, unknown>
): void => {
  Sentry.addBreadcrumb({
    category: "workflow",
    message: action,
    data,
    level: "info",
  });
};

/**
 * Create parser context object for passing to captureWebhookError.
 *
 * Instead of using global setContext (which could leak between requests),
 * return the context object to be passed explicitly to captureWebhookError.
 *
 * @param metadata - Parse operation metadata
 * @returns ParserContext object for use with captureWebhookError
 */
export const createParserContext = (metadata: {
  logBytes: number;
  jobCount: number;
  errorCount: number;
  parsersAvailable: string[];
  detectedUnsupportedTools?: string[];
}): ParserContext => metadata;

/**
 * Start a Sentry span for performance tracing.
 * Use this for significant operations like log fetching, parsing, etc.
 *
 * @param name - Span name describing the operation
 * @param op - Operation type (e.g., "http.client", "function")
 * @param callback - Async function to execute within the span
 * @returns Promise resolving to the callback's return value
 */
export const withSpan = <T>(
  name: string,
  op: string,
  callback: () => Promise<T>
): Promise<T> =>
  Sentry.startSpan(
    {
      name,
      op,
    },
    callback
  );
