import type { KVNamespace } from "@cloudflare/workers-types";

// ============================================================================
// Types
// ============================================================================

export interface ProcessingState {
  timestamp: number;
  processing: boolean;
  checkRunId?: number;
  /** Unique ID for the worker instance that acquired the lock */
  lockId?: string;
}

/** Internal type for commit lock state with required lockId (used in write-then-verify) */
interface CommitLockState {
  timestamp: number;
  processing: boolean;
  lockId: string;
}

interface LockAcquireResult {
  acquired: boolean;
  state?: ProcessingState;
  kvError?: boolean;
  validationError?: boolean;
}

interface PrCommentLockResult {
  acquired: boolean;
  lockId?: string;
  kvError?: boolean;
  validationError?: boolean;
  /** Lock holder info when acquisition fails (for observability) */
  holderInfo?: {
    lockId: string;
    timestamp: number;
    ageMs: number;
  };
}

interface PrCommentLockState {
  lockId: string;
  timestamp: number;
}

// ============================================================================
// Constants
// ============================================================================

// HACK: KV TTL minimum is 60 seconds per Cloudflare docs. Using 5 minutes for safety margin.
const IDEMPOTENCY_TTL_SECONDS = 5 * 60; // 5 minutes

// Edge cache TTL for KV reads - reduces latency for hot keys
// Per Cloudflare docs: hot keys see 500μs to 10ms latency with caching
// Set lower than IDEMPOTENCY_TTL to ensure we see updates reasonably quickly
// while still benefiting from edge caching for rapid duplicate webhooks
const KV_CACHE_TTL_SECONDS = 30;

// Stale lock threshold - locks older than this are considered abandoned
const STALE_LOCK_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// Namespace prefix for all idempotency keys (allows sharing KV namespace if needed)
const KEY_PREFIX = "detent:idem:commit";

// ============================================================================
// Input Validation (Defense-in-depth)
// ============================================================================
// Webhooks are signed by GitHub, so these inputs should always be valid.
// However, we validate anyway to prevent injection or malformed key issues.

// Maximum repository name length (owner/repo). GitHub limits owner to 39 chars
// and repo to 100 chars, so 39 + 1 + 100 = 140. Using 200 for safety.
const MAX_REPOSITORY_LENGTH = 200;

// Git SHA format: exactly 40 hex characters
const SHA_REGEX = /^[0-9a-f]{40}$/i;

// GitHub repository format: owner/repo
// Owner: alphanumeric or single hyphens (not at start/end), 1-39 chars
// Repo: alphanumeric, hyphens, underscores, dots, 1-100 chars
// This regex is permissive to handle edge cases while blocking obviously invalid input
const REPOSITORY_REGEX =
  /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9._-]{1,100}$/;

/**
 * Validates inputs before using them in KV keys.
 * Returns normalized values if valid, null if validation fails.
 */
const validateInputs = (
  repository: string,
  headSha: string
): { repository: string; headSha: string } | null => {
  if (!SHA_REGEX.test(headSha)) {
    console.warn(
      `[idempotency] Invalid SHA format rejected: ${headSha.substring(0, 20)}...`
    );
    return null;
  }

  if (
    repository.length > MAX_REPOSITORY_LENGTH ||
    !REPOSITORY_REGEX.test(repository)
  ) {
    console.warn(
      `[idempotency] Invalid repository format rejected: ${repository.substring(0, 50)}...`
    );
    return null;
  }

  // Normalize to lowercase for consistent key generation
  return {
    repository: repository.toLowerCase(),
    headSha: headSha.toLowerCase(),
  };
};

const buildKey = (repository: string, headSha: string): string =>
  `${KEY_PREFIX}:${repository}:${headSha}`;

// ============================================================================
// Core Lock Operations (Write-then-Verify Pattern)
// ============================================================================
// KV is eventually consistent and does NOT support atomic check-and-set.
// We use write-then-verify to mitigate race conditions:
// 1. Write our lock state with a unique lockId
// 2. Read back to verify we own the lock
// 3. If another worker's lockId appears, we lost the race
//
// This doesn't eliminate races (eventual consistency means reads may be stale)
// but significantly reduces the window. The database unique constraint is the
// ultimate safety net for deduplication.

/**
 * Default blocking predicate: block if lock is not stale (age-based only).
 */
const defaultShouldBlock = <T extends { lockId: string; timestamp: number }>(
  _existing: T,
  ageMs: number,
  staleThresholdMs: number
): boolean => ageMs <= staleThresholdMs;

/**
 * Generic lock acquisition with write-then-verify pattern.
 * Handles stale lock recovery and race detection.
 *
 * @param shouldBlock - Optional predicate to determine if existing lock should block.
 *                      Default blocks if lock is not stale (age <= staleThresholdMs).
 *                      Return true to block acquisition, false to allow takeover.
 */
const tryAcquireLock = async <T extends { lockId: string; timestamp: number }>(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  staleThresholdMs: number,
  buildState: (lockId: string) => T,
  logPrefix: string,
  shouldBlock: (
    existing: T,
    ageMs: number,
    staleThresholdMs: number
  ) => boolean = defaultShouldBlock
): Promise<{ acquired: boolean; state?: T; lockId?: string }> => {
  const lockId = crypto.randomUUID();

  // Check for existing lock with edge caching for hot keys
  const existing = await kv.get<T>(key, {
    type: "json",
    cacheTtl: KV_CACHE_TTL_SECONDS,
  });

  if (existing) {
    const ageMs = Date.now() - existing.timestamp;

    // Use predicate to determine if we should block
    if (shouldBlock(existing, ageMs, staleThresholdMs)) {
      return { acquired: false, state: existing };
    }

    // Lock can be taken over - log and proceed
    console.log(
      `[${logPrefix}] Taking over lock for ${key} (age: ${Math.round(ageMs / 1000)}s)`
    );
  }

  // Write our lock state
  const state = buildState(lockId);
  await kv.put(key, JSON.stringify(state), { expirationTtl: ttlSeconds });

  // Write-then-verify: read back without cache to check ownership
  const verification = await kv.get<T>(key, "json");

  if (verification && verification.lockId !== lockId) {
    // Another worker won the race
    console.log(`[${logPrefix}] Lost lock race for ${key}`);
    return { acquired: false, state: verification };
  }

  return { acquired: true, state, lockId };
};

/**
 * Attempts to acquire a distributed lock for processing a commit.
 *
 * IMPORTANT: KV is eventually consistent and does NOT support atomic check-and-set.
 * This means there is a race window between get() and put() where multiple workers
 * could both "acquire" the lock. This is acceptable for our use case because:
 *
 * 1. The database has a unique constraint on (repository, commitSha, runId) as the
 *    ultimate source of truth for deduplication
 * 2. We also check checkExistingRunsInDb() before processing
 * 3. KV serves as a fast-path optimization to reduce duplicate work, not as a
 *    guarantee of mutual exclusion
 *
 * For true distributed locking, Durable Objects would be required. However, the
 * defense-in-depth approach here (KV + DB constraint) is sufficient for webhook
 * deduplication where occasional duplicate processing is acceptable but should
 * be minimized.
 */
/**
 * Blocking predicate for commit locks: block only if actively processing AND not stale.
 * This allows re-acquisition for:
 * 1. Completed processing (processing=false) - enables re-run handling
 * 2. Stale locks (processing=true but > threshold) - crashed worker recovery
 */
const commitLockShouldBlock = (
  existing: CommitLockState,
  ageMs: number,
  staleThresholdMs: number
): boolean => existing.processing && ageMs <= staleThresholdMs;

export const acquireCommitLock = async (
  kv: KVNamespace,
  repository: string,
  headSha: string
): Promise<LockAcquireResult> => {
  // Validate inputs before using in KV key (defense-in-depth)
  const validated = validateInputs(repository, headSha);
  if (!validated) {
    // Invalid input - fail open but flag the validation error
    // This should never happen with signed webhooks, but log for monitoring
    return { acquired: true, validationError: true };
  }

  const key = buildKey(validated.repository, validated.headSha);

  try {
    const result = await tryAcquireLock<CommitLockState>(
      kv,
      key,
      IDEMPOTENCY_TTL_SECONDS,
      STALE_LOCK_THRESHOLD_MS,
      (lockId) => ({
        timestamp: Date.now(),
        processing: true,
        lockId,
      }),
      "idempotency",
      commitLockShouldBlock
    );

    return {
      acquired: result.acquired,
      state: result.state,
    };
  } catch (error) {
    // Fail-open: if KV fails, allow processing (DB constraint is safety net)
    console.error(
      "[idempotency] acquireCommitLock failed, proceeding with fail-open:",
      error
    );
    return { acquired: true, kvError: true };
  }
};

/**
 * Releases a lock after processing completes or when processing cannot complete
 * (e.g., waiting for other runs).
 * This allows a future webhook to retry processing.
 *
 * Note: Due to eventual consistency, there may be a brief window where the lock
 * appears to still exist after deletion. This is acceptable for our use case.
 */
export const releaseCommitLock = async (
  kv: KVNamespace,
  repository: string,
  headSha: string
): Promise<void> => {
  // Validate inputs (defense-in-depth)
  const validated = validateInputs(repository, headSha);
  if (!validated) {
    // Skip KV delete for invalid inputs - TTL will clean up anyway
    return;
  }

  const key = buildKey(validated.repository, validated.headSha);

  try {
    await kv.delete(key);
  } catch (error) {
    // Non-critical: TTL will clean up eventually
    console.error("[idempotency] releaseCommitLock failed:", error);
  }
};

// ============================================================================
// Check Run Tracking
// ============================================================================
// Separate key prefix for storing check run IDs created during "waiting" state
// This allows the check run to be created early (on workflow_run.in_progress)
// and updated later (on workflow_run.completed)

const CHECK_RUN_KEY_PREFIX = "detent:checkrun";

const buildCheckRunKey = (repository: string, headSha: string): string =>
  `${CHECK_RUN_KEY_PREFIX}:${repository}:${headSha}`;

/**
 * Stores the check run ID for a commit. Used when creating the check run early
 * (on workflow_run.in_progress) so it can be retrieved and updated later.
 */
export const storeCheckRunId = async (
  kv: KVNamespace,
  repository: string,
  headSha: string,
  checkRunId: number
): Promise<void> => {
  const validated = validateInputs(repository, headSha);
  if (!validated) {
    return;
  }

  const key = buildCheckRunKey(validated.repository, validated.headSha);

  try {
    await kv.put(key, String(checkRunId), {
      expirationTtl: IDEMPOTENCY_TTL_SECONDS,
    });
  } catch (error) {
    console.error("[idempotency] storeCheckRunId failed:", error);
  }
};

/**
 * Retrieves a previously stored check run ID for a commit.
 * Returns null if not found or on error.
 */
export const getStoredCheckRunId = async (
  kv: KVNamespace,
  repository: string,
  headSha: string
): Promise<number | null> => {
  const validated = validateInputs(repository, headSha);
  if (!validated) {
    console.warn(
      `[idempotency] getStoredCheckRunId: validation failed for ${repository}@${headSha.slice(0, 7)}`
    );
    return null;
  }

  const key = buildCheckRunKey(validated.repository, validated.headSha);

  try {
    const value = await kv.get(key, {
      cacheTtl: KV_CACHE_TTL_SECONDS,
    });
    if (value) {
      const checkRunId = Number.parseInt(value, 10);
      console.log(
        `[idempotency] getStoredCheckRunId: found ${checkRunId} for ${repository}@${headSha.slice(0, 7)}`
      );
      return checkRunId;
    }
    // Expected for first-time lookups before check run creation
    console.log(
      `[idempotency] getStoredCheckRunId: no check run found for ${repository}@${headSha.slice(0, 7)}`
    );
    return null;
  } catch (error) {
    console.error(
      `[idempotency] getStoredCheckRunId failed for ${repository}@${headSha.slice(0, 7)}:`,
      error
    );
    return null;
  }
};

// ============================================================================
// Comment ID Tracking
// ============================================================================
// Store comment IDs to allow editing/updating existing comments instead of
// creating new ones (prevents comment spam on PRs)

const COMMENT_KEY_PREFIX = "detent:comment";

// Comment IDs need longer TTL than commit locks since PRs can have failures
// across many commits over hours/days. 24 hours ensures we update existing
// comments rather than creating duplicates on long-running PRs.
const COMMENT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

const buildCommentKey = (repository: string, prNumber: number): string =>
  `${COMMENT_KEY_PREFIX}:${repository}:${prNumber}`;

/**
 * Validates repository and PR number for comment/lock operations.
 * Returns normalized repository (lowercase) if valid, null otherwise.
 */
const validatePrInputs = (
  repository: string,
  prNumber: number
): string | null => {
  // PR numbers must be positive integers within reasonable bounds
  // GitHub uses 32-bit integers, max is ~2.1 billion
  if (
    !Number.isInteger(prNumber) ||
    prNumber <= 0 ||
    prNumber > 2_147_483_647
  ) {
    console.warn(`[idempotency] Invalid PR number rejected: ${prNumber}`);
    return null;
  }

  // Validate repository format (same as commit lock validation)
  if (
    repository.length > MAX_REPOSITORY_LENGTH ||
    !REPOSITORY_REGEX.test(repository)
  ) {
    console.warn(
      `[idempotency] Invalid repository format for PR operation: ${repository.substring(0, 50)}...`
    );
    return null;
  }

  return repository.toLowerCase();
};

/**
 * Stores the comment ID for a PR. Used to update existing comments instead of
 * creating new ones on subsequent webhook calls.
 */
export const storeCommentId = async (
  kv: KVNamespace,
  repository: string,
  prNumber: number,
  commentId: number
): Promise<void> => {
  const normalizedRepo = validatePrInputs(repository, prNumber);
  if (!normalizedRepo) {
    return;
  }

  // Validate commentId is a positive integer
  if (!Number.isInteger(commentId) || commentId <= 0) {
    console.warn(`[idempotency] Invalid comment ID rejected: ${commentId}`);
    return;
  }

  const key = buildCommentKey(normalizedRepo, prNumber);

  try {
    await kv.put(key, String(commentId), {
      expirationTtl: COMMENT_TTL_SECONDS,
    });
  } catch (error) {
    console.error("[idempotency] storeCommentId failed:", error);
  }
};

/**
 * Retrieves a previously stored comment ID for a PR.
 * Returns null if not found or on error.
 */
export const getStoredCommentId = async (
  kv: KVNamespace,
  repository: string,
  prNumber: number
): Promise<number | null> => {
  const normalizedRepo = validatePrInputs(repository, prNumber);
  if (!normalizedRepo) {
    return null;
  }

  const key = buildCommentKey(normalizedRepo, prNumber);

  try {
    const value = await kv.get(key, {
      cacheTtl: KV_CACHE_TTL_SECONDS,
    });
    if (!value) {
      return null;
    }
    // Validate parsed value is a positive integer
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.warn(`[idempotency] Invalid stored comment ID: ${value}`);
      return null;
    }
    return parsed;
  } catch (error) {
    console.error("[idempotency] getStoredCommentId failed:", error);
    return null;
  }
};

// ============================================================================
// PR Comment Lock
// ============================================================================
// Prevents race conditions when multiple commits on the same PR try to
// create/update comments simultaneously. This is separate from the commit
// lock because different commits can race to post comments on the same PR.

const PR_COMMENT_LOCK_PREFIX = "detent:pr-comment-lock";

// Short TTL since comment operations should complete quickly (< 30 seconds)
const PR_COMMENT_LOCK_TTL_SECONDS = 60;

// Stale threshold for PR comment locks (30 seconds)
const PR_COMMENT_LOCK_STALE_MS = 30 * 1000;

const buildPrCommentLockKey = (repository: string, prNumber: number): string =>
  `${PR_COMMENT_LOCK_PREFIX}:${repository}:${prNumber}`;

/**
 * Attempts to acquire a lock for comment operations on a specific PR.
 * This prevents race conditions when multiple commits on the same PR
 * try to create/update comments simultaneously.
 *
 * Uses write-then-verify pattern to mitigate KV eventual consistency issues.
 */
export const acquirePrCommentLock = async (
  kv: KVNamespace,
  repository: string,
  prNumber: number
): Promise<PrCommentLockResult> => {
  const normalizedRepo = validatePrInputs(repository, prNumber);
  if (!normalizedRepo) {
    // Invalid input - fail open but flag validation error for monitoring
    return { acquired: true, validationError: true };
  }

  const key = buildPrCommentLockKey(normalizedRepo, prNumber);

  try {
    const result = await tryAcquireLock<PrCommentLockState>(
      kv,
      key,
      PR_COMMENT_LOCK_TTL_SECONDS,
      PR_COMMENT_LOCK_STALE_MS,
      (lockId) => ({ lockId, timestamp: Date.now() }),
      "pr-comment-lock"
    );

    if (result.acquired) {
      console.log(
        `[pr-comment-lock] Acquired lock for ${repository}#${prNumber}`
      );
      return {
        acquired: true,
        lockId: result.lockId,
      };
    }

    // Lock not acquired - return holder info for observability
    const holderState = result.state;
    const holderInfo = holderState
      ? {
          lockId: holderState.lockId,
          timestamp: holderState.timestamp,
          ageMs: Date.now() - holderState.timestamp,
        }
      : undefined;

    console.log(
      `[pr-comment-lock] Lock held for ${repository}#${prNumber}` +
        (holderInfo ? ` (age: ${Math.round(holderInfo.ageMs / 1000)}s)` : "")
    );

    return {
      acquired: false,
      holderInfo,
    };
  } catch (error) {
    // Fail-open: DB unique constraint on pr_comments is safety net
    console.error(
      `[pr-comment-lock] acquirePrCommentLock failed for ${repository}#${prNumber}, proceeding with fail-open:`,
      error
    );
    return { acquired: true, kvError: true };
  }
};

/**
 * Releases the PR comment lock after comment operations complete.
 */
export const releasePrCommentLock = async (
  kv: KVNamespace,
  repository: string,
  prNumber: number
): Promise<void> => {
  const normalizedRepo = validatePrInputs(repository, prNumber);
  if (!normalizedRepo) {
    // Skip release for invalid inputs - TTL will clean up anyway
    return;
  }

  const key = buildPrCommentLockKey(normalizedRepo, prNumber);

  try {
    await kv.delete(key);
    console.log(
      `[pr-comment-lock] Released lock for ${repository}#${prNumber}`
    );
  } catch (error) {
    // Non-critical: TTL will clean up
    console.error(
      `[pr-comment-lock] releasePrCommentLock failed for ${repository}#${prNumber}:`,
      error
    );
  }
};

// ============================================================================
// Heal Creation Lock
// ============================================================================
// Prevents duplicate heal creation for the same PR+source combination.
// This is necessary because webhooks can fire multiple times rapidly, and
// the database check for existing heals has a race window.

const HEAL_CREATION_LOCK_PREFIX = "detent:heal:create";

// Same TTL as commit locks (5 minutes)
const HEAL_CREATION_LOCK_TTL_SECONDS = 5 * 60;

// Stale threshold for heal creation locks (2 minutes)
const HEAL_CREATION_LOCK_STALE_MS = 2 * 60 * 1000;

// UUID format for project IDs
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Autofix source should be alphanumeric with optional hyphens/underscores
const AUTOFIX_SOURCE_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;

interface HealCreationLockState {
  lockId: string;
  timestamp: number;
}

interface HealCreationLockResult {
  acquired: boolean;
  lockId?: string;
  kvError?: boolean;
  validationError?: boolean;
}

/**
 * Validates inputs for heal creation lock operations.
 * Returns normalized project ID if valid, null otherwise.
 */
const validateHealCreationInputs = (
  projectId: string,
  prNumber: number,
  autofixSource: string
): { projectId: string; prNumber: number; autofixSource: string } | null => {
  if (!UUID_REGEX.test(projectId)) {
    console.warn(
      `[heal-creation-lock] Invalid project ID format rejected: ${projectId.substring(0, 20)}...`
    );
    return null;
  }

  // PR numbers must be positive integers within reasonable bounds
  if (
    !Number.isInteger(prNumber) ||
    prNumber <= 0 ||
    prNumber > 2_147_483_647
  ) {
    console.warn(
      `[heal-creation-lock] Invalid PR number rejected: ${prNumber}`
    );
    return null;
  }

  if (!AUTOFIX_SOURCE_REGEX.test(autofixSource)) {
    console.warn(
      `[heal-creation-lock] Invalid autofix source rejected: ${autofixSource.substring(0, 20)}...`
    );
    return null;
  }

  return {
    projectId: projectId.toLowerCase(),
    prNumber,
    autofixSource: autofixSource.toLowerCase(),
  };
};

const buildHealCreationLockKey = (
  projectId: string,
  prNumber: number,
  autofixSource: string
): string =>
  `${HEAL_CREATION_LOCK_PREFIX}:${projectId}:${prNumber}:${autofixSource}`;

/**
 * Attempts to acquire a lock for creating a heal for a specific PR+source.
 * This prevents duplicate heal creation when multiple webhooks fire rapidly.
 *
 * Uses write-then-verify pattern to mitigate KV eventual consistency issues.
 */
export const acquireHealCreationLock = async (
  kv: KVNamespace,
  projectId: string,
  prNumber: number,
  autofixSource: string
): Promise<HealCreationLockResult> => {
  const validated = validateHealCreationInputs(
    projectId,
    prNumber,
    autofixSource
  );
  if (!validated) {
    // Invalid input - fail open but flag validation error for monitoring
    return { acquired: true, validationError: true };
  }

  const key = buildHealCreationLockKey(
    validated.projectId,
    validated.prNumber,
    validated.autofixSource
  );

  try {
    const result = await tryAcquireLock<HealCreationLockState>(
      kv,
      key,
      HEAL_CREATION_LOCK_TTL_SECONDS,
      HEAL_CREATION_LOCK_STALE_MS,
      (lockId) => ({ lockId, timestamp: Date.now() }),
      "heal-creation-lock"
    );

    if (result.acquired) {
      console.log(
        `[heal-creation-lock] Acquired lock for project=${projectId} PR#${prNumber} source=${autofixSource}`
      );
    } else {
      console.log(
        `[heal-creation-lock] Lock held for project=${projectId} PR#${prNumber} source=${autofixSource}, skipping`
      );
    }

    return {
      acquired: result.acquired,
      lockId: result.lockId,
    };
  } catch (error) {
    // Fail-open: DB unique constraint is safety net
    console.error(
      `[heal-creation-lock] acquireHealCreationLock failed for project=${projectId} PR#${prNumber} source=${autofixSource}, proceeding with fail-open:`,
      error
    );
    return { acquired: true, kvError: true };
  }
};

/**
 * Releases the heal creation lock after heal creation completes or fails.
 */
export const releaseHealCreationLock = async (
  kv: KVNamespace,
  projectId: string,
  prNumber: number,
  autofixSource: string
): Promise<void> => {
  const validated = validateHealCreationInputs(
    projectId,
    prNumber,
    autofixSource
  );
  if (!validated) {
    // Skip release for invalid inputs - TTL will clean up anyway
    return;
  }

  const key = buildHealCreationLockKey(
    validated.projectId,
    validated.prNumber,
    validated.autofixSource
  );

  try {
    await kv.delete(key);
    console.log(
      `[heal-creation-lock] Released lock for project=${projectId} PR#${prNumber} source=${autofixSource}`
    );
  } catch (error) {
    // Non-critical: TTL will clean up
    console.error(
      `[heal-creation-lock] releaseHealCreationLock failed for project=${projectId} PR#${prNumber} source=${autofixSource}:`,
      error
    );
  }
};

// ============================================================================
// Heal Command Lock
// ============================================================================
// Prevents race conditions when two @detent heal commands are posted
// simultaneously on the same PR. This ensures only one heal orchestration
// runs at a time per PR, preventing duplicate heals even when the
// existingHeals DB check has a race window.

const HEAL_COMMAND_LOCK_PREFIX = "detent:heal:command";

// Short TTL since heal orchestration should complete within 30 seconds
const HEAL_COMMAND_LOCK_TTL_SECONDS = 60;

// Stale threshold for heal command locks (30 seconds)
const HEAL_COMMAND_LOCK_STALE_MS = 30 * 1000;

interface HealCommandLockState {
  lockId: string;
  timestamp: number;
}

interface HealCommandLockResult {
  acquired: boolean;
  lockId?: string;
  kvError?: boolean;
  validationError?: boolean;
}

/**
 * Validates inputs for heal command lock operations.
 */
const validateHealCommandInputs = (
  projectId: string,
  prNumber: number
): { projectId: string; prNumber: number } | null => {
  if (!UUID_REGEX.test(projectId)) {
    console.warn(
      `[heal-command-lock] Invalid project ID format rejected: ${projectId.substring(0, 20)}...`
    );
    return null;
  }

  if (
    !Number.isInteger(prNumber) ||
    prNumber <= 0 ||
    prNumber > 2_147_483_647
  ) {
    console.warn(`[heal-command-lock] Invalid PR number rejected: ${prNumber}`);
    return null;
  }

  return {
    projectId: projectId.toLowerCase(),
    prNumber,
  };
};

const buildHealCommandLockKey = (projectId: string, prNumber: number): string =>
  `${HEAL_COMMAND_LOCK_PREFIX}:${projectId}:${prNumber}`;

/**
 * Attempts to acquire a lock for the @detent heal command on a specific PR.
 * This prevents race conditions when multiple heal commands are posted
 * simultaneously, ensuring only one orchestration runs at a time.
 */
export const acquireHealCommandLock = async (
  kv: KVNamespace,
  projectId: string,
  prNumber: number
): Promise<HealCommandLockResult> => {
  const validated = validateHealCommandInputs(projectId, prNumber);
  if (!validated) {
    return { acquired: true, validationError: true };
  }

  const key = buildHealCommandLockKey(validated.projectId, validated.prNumber);

  try {
    const result = await tryAcquireLock<HealCommandLockState>(
      kv,
      key,
      HEAL_COMMAND_LOCK_TTL_SECONDS,
      HEAL_COMMAND_LOCK_STALE_MS,
      (lockId) => ({ lockId, timestamp: Date.now() }),
      "heal-command-lock"
    );

    if (result.acquired) {
      console.log(
        `[heal-command-lock] Acquired lock for project=${projectId} PR#${prNumber}`
      );
    } else {
      console.log(
        `[heal-command-lock] Lock held for project=${projectId} PR#${prNumber}, skipping`
      );
    }

    return {
      acquired: result.acquired,
      lockId: result.lockId,
    };
  } catch (error) {
    console.error(
      `[heal-command-lock] acquireHealCommandLock failed for project=${projectId} PR#${prNumber}, proceeding with fail-open:`,
      error
    );
    return { acquired: true, kvError: true };
  }
};

/**
 * Releases the heal command lock after orchestration completes or fails.
 */
export const releaseHealCommandLock = async (
  kv: KVNamespace,
  projectId: string,
  prNumber: number
): Promise<void> => {
  const validated = validateHealCommandInputs(projectId, prNumber);
  if (!validated) {
    return;
  }

  const key = buildHealCommandLockKey(validated.projectId, validated.prNumber);

  try {
    await kv.delete(key);
    console.log(
      `[heal-command-lock] Released lock for project=${projectId} PR#${prNumber}`
    );
  } catch (error) {
    console.error(
      `[heal-command-lock] releaseHealCommandLock failed for project=${projectId} PR#${prNumber}:`,
      error
    );
  }
};
