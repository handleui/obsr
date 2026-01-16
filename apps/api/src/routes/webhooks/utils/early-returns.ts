import type { KVNamespace } from "@cloudflare/workers-types";
import type { createGitHubService } from "../../../services/github";
import { releaseCommitLock } from "../../../services/idempotency";
import {
  classifyError,
  ERROR_CODES,
} from "../../../services/webhooks/error-classifier";

// ============================================================================
// Helper: Clean up check run on error (prevents stale "in progress" state)
// ============================================================================
export const cleanupCheckRunOnError = async (
  github: ReturnType<typeof createGitHubService>,
  token: string,
  owner: string,
  repo: string,
  checkRunId: number,
  context?: { deliveryId?: string; error?: unknown }
): Promise<void> => {
  const classified = context?.error
    ? classifyError(context.error)
    : { code: ERROR_CODES.UNKNOWN, message: "Unknown error" };
  const deliveryId = context?.deliveryId ?? "unknown";

  try {
    await github.updateCheckRun(token, {
      owner,
      repo,
      checkRunId,
      status: "completed",
      conclusion: "cancelled",
      output: {
        title: `Analysis failed: ${classified.code}`,
        summary: [
          `**Error:** ${classified.message}`,
          "",
          classified.hint ? `**Hint:** ${classified.hint}` : "",
          "",
          "---",
          `**Delivery ID:** \`${deliveryId}\``,
          "",
          "Use the delivery ID to correlate with server logs for detailed debugging.",
          "This webhook may be automatically retried by GitHub.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    });
    console.log(
      `[workflow_run] Cleaned up check run ${checkRunId} after error [delivery: ${deliveryId}]`
    );
  } catch (cleanupError) {
    console.error(
      `[workflow_run] Failed to clean up check run ${checkRunId}:`,
      cleanupError
    );
  }
};

// ============================================================================
// Helper: Attempt check run cleanup with token recovery
// ============================================================================
// When errors occur, try to clean up the check run to avoid orphaned "queued" state.
// If token isn't available, attempt to recover it first.
export const attemptCheckRunCleanup = async (
  github: ReturnType<typeof createGitHubService>,
  token: string | undefined,
  installationId: number,
  owner: string,
  repo: string,
  checkRunId: number,
  deliveryId: string,
  originalError?: unknown
): Promise<void> => {
  const errorContext = { deliveryId, error: originalError };

  if (token) {
    await cleanupCheckRunOnError(
      github,
      token,
      owner,
      repo,
      checkRunId,
      errorContext
    );
    return;
  }

  // Token failed to obtain - try to get it again for cleanup
  console.log(
    `[workflow_run] Attempting token recovery for check run cleanup [delivery: ${deliveryId}]`
  );
  try {
    const recoveryToken = await github.getInstallationToken(installationId);
    await cleanupCheckRunOnError(
      github,
      recoveryToken,
      owner,
      repo,
      checkRunId,
      errorContext
    );
  } catch (tokenError) {
    console.error(
      `[workflow_run] Failed to recover token for cleanup, check run ${checkRunId} may be orphaned [delivery: ${deliveryId}]:`,
      tokenError
    );
  }
};

// ============================================================================
// Helper: Handle early return when no PR is associated with workflow run
// ============================================================================
// Cleans up any orphaned check run and releases the commit lock before returning.
export const handleNoPrEarlyReturn = async (
  github: ReturnType<typeof createGitHubService>,
  token: string,
  kv: KVNamespace,
  context: {
    installationId: number;
    owner: string;
    repo: string;
    repository: string;
    headSha: string;
    runId: number;
    deliveryId: string;
    storedCheckRunId: number | null;
  }
): Promise<{
  message: string;
  repository: string;
  runId: number;
  status: string;
}> => {
  const {
    installationId,
    owner,
    repo,
    repository,
    headSha,
    runId,
    deliveryId,
    storedCheckRunId,
  } = context;

  console.log("[workflow_run] No associated PR found, skipping");

  // Clean up any existing check run since we won't process this
  if (storedCheckRunId) {
    await attemptCheckRunCleanup(
      github,
      token,
      installationId,
      owner,
      repo,
      storedCheckRunId,
      deliveryId
    );
  }

  await releaseCommitLock(kv, repository, headSha);

  return {
    message: "workflow_run processed",
    repository,
    runId,
    status: "no_pr",
  };
};

// ============================================================================
// Helper: Handle early return when waiting for other runs to complete
// ============================================================================
// Releases the commit lock but preserves the check run in "queued" state.
// The check run will be finalized when all workflows complete.
// Note: _github and _token are unused but kept for API consistency with other early-return helpers
export const handleWaitingForRunsEarlyReturn = async (
  _github: ReturnType<typeof createGitHubService>,
  _token: string,
  kv: KVNamespace,
  context: {
    installationId: number;
    owner: string;
    repo: string;
    repository: string;
    headSha: string;
    deliveryId: string;
    storedCheckRunId: number | null;
    completedCount: number;
    pendingCount: number;
  }
): Promise<{
  message: string;
  repository: string;
  completed: number;
  pending: number;
}> => {
  const { repository, headSha, completedCount, pendingCount } = context;

  console.log(
    `[workflow_run] Waiting for ${pendingCount} more runs to complete`
  );

  // NOTE: Do NOT clean up the check run here. It should remain in "queued" state
  // and will be properly finalized when all workflows complete. Cleaning it up
  // here would mark it as "cancelled" prematurely.

  await releaseCommitLock(kv, repository, headSha);

  return {
    message: "waiting for other runs",
    repository,
    completed: completedCount,
    pending: pendingCount,
  };
};

// ============================================================================
// Helper: Handle early return when all runs already processed (duplicate)
// ============================================================================
// Releases the commit lock. The check run was already finalized by the original
// processing, so we don't touch it.
export const handleAllRunsProcessedEarlyReturn = async (
  _github: ReturnType<typeof createGitHubService>,
  _token: string,
  kv: KVNamespace,
  context: {
    installationId: number;
    owner: string;
    repo: string;
    repository: string;
    headSha: string;
    deliveryId: string;
    storedCheckRunId: number | null;
    runCount: number;
  }
): Promise<{
  message: string;
  repository: string;
  headSha: string;
  status: string;
}> => {
  const { repository, headSha, deliveryId, runCount } = context;

  console.log(
    `[workflow_run] All ${runCount} run attempts already stored, skipping [delivery: ${deliveryId}]`
  );

  // NOTE: Do NOT clean up the check run here. All runs were already processed,
  // which means the check run was already finalized (completed with success or
  // failure) by the original webhook. Cleaning it up would wrongly overwrite
  // that result with "cancelled".

  await releaseCommitLock(kv, repository, headSha);

  return {
    message: "already processed (db check)",
    repository,
    headSha,
    status: "duplicate_db",
  };
};
