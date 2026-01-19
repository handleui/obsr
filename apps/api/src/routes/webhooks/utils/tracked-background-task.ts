import type { ExecutionContext } from "@cloudflare/workers-types";
import { captureWebhookError } from "../../../lib/sentry";
import { ERROR_CODES } from "../../../services/webhooks/error-classifier";

// ============================================================================
// Background Task Tracking
// ============================================================================
// Wraps `waitUntil()` operations with proper error handling, Sentry capture,
// and optional fallback actions. Without this, background task failures are
// silently swallowed - the webhook returns 200 OK but users never know why
// their PR comment didn't update or check run is stale.

export interface BackgroundTaskContext {
  /** GitHub delivery ID for correlation */
  deliveryId: string;
  /** Repository full name (owner/repo) */
  repository: string;
  /** PR number if applicable */
  prNumber?: number;
  /** Human-readable operation name for logging */
  operation: string;
  /** GitHub installation ID */
  installationId?: number;
  /** Workflow run ID if applicable */
  runId?: number;
}

export interface TrackedTask {
  /** The promise to track */
  task: Promise<unknown>;
  /** Context for error reporting */
  context: BackgroundTaskContext;
  /** Whether this task failure is critical (affects user experience) */
  critical?: boolean;
}

/**
 * Wrap a background task with error tracking and Sentry capture.
 *
 * Use this instead of raw `waitUntil()` for any operation that affects
 * user-visible state (PR comments, check runs, etc.).
 *
 * @param task - The async operation to track
 * @param context - Context for error reporting and correlation
 * @returns A promise that never rejects (errors are captured internally)
 */
export const trackBackgroundTask = async (
  task: Promise<unknown>,
  context: BackgroundTaskContext
): Promise<void> => {
  try {
    await task;
  } catch (error) {
    console.error(
      `[${context.operation}] Background task failed for ${context.repository}:`,
      error
    );

    captureWebhookError(error, ERROR_CODES.BACKGROUND_TASK, {
      eventType: `background.${context.operation}`,
      deliveryId: context.deliveryId,
      repository: context.repository,
      prNumber: context.prNumber,
      installationId: context.installationId,
      runId: context.runId,
    });
  }
};

/**
 * Track multiple background tasks with individual error handling.
 *
 * Unlike `Promise.all()`, this ensures ALL tasks are attempted even if
 * some fail early. Each failure is captured independently with proper context.
 *
 * @param tasks - Array of tasks with their contexts
 * @returns A promise that resolves when all tasks complete (never rejects)
 */
export const trackBackgroundTasks = async (
  tasks: TrackedTask[]
): Promise<void> => {
  await Promise.all(
    tasks.map(({ task, context }) => trackBackgroundTask(task, context))
  );
};

/**
 * Create a tracked waitUntil wrapper for use in webhook handlers.
 *
 * This returns a function that combines `executionCtx.waitUntil()` with
 * error tracking. Use it as a drop-in replacement for raw waitUntil.
 *
 * @example
 * const waitUntilTracked = createTrackedWaitUntil(c.executionCtx, {
 *   deliveryId,
 *   repository: repository.full_name,
 * });
 *
 * // Single task
 * waitUntilTracked(
 *   postWaitingComment(...),
 *   { operation: 'post_waiting_comment', prNumber }
 * );
 *
 * // Multiple tasks
 * waitUntilTracked([
 *   { task: updateCheckRun(...), context: { operation: 'update_check_run' } },
 *   { task: postComment(...), context: { operation: 'post_comment', prNumber } },
 * ]);
 */
export const createTrackedWaitUntil = (
  executionCtx: ExecutionContext,
  baseContext: Pick<
    BackgroundTaskContext,
    "deliveryId" | "repository" | "installationId"
  >
) => {
  /**
   * Overload 1: Single task with context
   */
  function waitUntilTracked(
    task: Promise<unknown>,
    context: Omit<BackgroundTaskContext, "deliveryId" | "repository">
  ): void;

  /**
   * Overload 2: Multiple tasks with individual contexts
   */
  function waitUntilTracked(
    tasks: Array<{
      task: Promise<unknown>;
      context: Omit<
        BackgroundTaskContext,
        "deliveryId" | "repository" | "installationId"
      >;
    }>
  ): void;

  function waitUntilTracked(
    taskOrTasks:
      | Promise<unknown>
      | Array<{
          task: Promise<unknown>;
          context: Omit<
            BackgroundTaskContext,
            "deliveryId" | "repository" | "installationId"
          >;
        }>,
    context?: Omit<BackgroundTaskContext, "deliveryId" | "repository">
  ): void {
    if (Array.isArray(taskOrTasks)) {
      // Multiple tasks with individual contexts
      const trackedTasks: TrackedTask[] = taskOrTasks.map((t) => ({
        task: t.task,
        context: { ...baseContext, ...t.context },
      }));
      executionCtx.waitUntil(trackBackgroundTasks(trackedTasks));
    } else {
      // Single task - context is required by the overload, but handle missing gracefully
      // This guards against accidental misuse without silent failure
      const fullContext: BackgroundTaskContext = {
        ...baseContext,
        operation: context?.operation ?? "unknown_operation",
        ...context,
      };
      executionCtx.waitUntil(trackBackgroundTask(taskOrTasks, fullContext));
    }
  }

  return waitUntilTracked;
};
