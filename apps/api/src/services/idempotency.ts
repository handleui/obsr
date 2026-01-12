import type { KVNamespace } from "@cloudflare/workers-types";

export interface ProcessingState {
  timestamp: number;
  processing: boolean;
  checkRunId?: number;
  /** Unique ID for the worker instance that acquired the lock */
  lockId?: string;
}

// HACK: KV TTL minimum is 60 seconds per Cloudflare docs. Using 5 minutes for safety margin.
const IDEMPOTENCY_TTL_SECONDS = 5 * 60; // 5 minutes

// Edge cache TTL for KV reads - reduces latency for hot keys
// Per Cloudflare docs: hot keys see 500μs to 10ms latency with caching
// Set lower than IDEMPOTENCY_TTL to ensure we see updates reasonably quickly
// while still benefiting from edge caching for rapid duplicate webhooks
const KV_CACHE_TTL_SECONDS = 30;

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
export const acquireCommitLock = async (
  kv: KVNamespace,
  repository: string,
  headSha: string
): Promise<{
  acquired: boolean;
  state?: ProcessingState;
  kvError?: boolean;
  validationError?: boolean;
}> => {
  // Validate inputs before using in KV key (defense-in-depth)
  const validated = validateInputs(repository, headSha);
  if (!validated) {
    // Invalid input - fail open but flag the validation error
    // This should never happen with signed webhooks, but log for monitoring
    return { acquired: true, validationError: true };
  }

  const key = buildKey(validated.repository, validated.headSha);
  const lockId = crypto.randomUUID();

  try {
    // Use cacheTtl for faster edge-cached reads on hot keys
    // Per Cloudflare docs: reduces latency from cold cache to 500μs-10ms for hot keys
    const existing = await kv.get<ProcessingState>(key, {
      type: "json",
      cacheTtl: KV_CACHE_TTL_SECONDS,
    });

    if (existing) {
      // Lock exists - check if it's stale (processing for too long)
      const ageMs = Date.now() - existing.timestamp;
      const staleThresholdMs = 2 * 60 * 1000; // 2 minutes

      if (existing.processing && ageMs > staleThresholdMs) {
        // Stale lock - previous worker likely crashed. Take over the lock.
        console.warn(
          `[idempotency] Stale lock detected for ${key} (age: ${Math.round(ageMs / 1000)}s), taking over`
        );
        const state: ProcessingState = {
          timestamp: Date.now(),
          processing: true,
          lockId,
        };
        await kv.put(key, JSON.stringify(state), {
          expirationTtl: IDEMPOTENCY_TTL_SECONDS,
        });
        return { acquired: true, state };
      }

      return { acquired: false, state: existing };
    }

    // No existing lock - attempt to acquire it
    const state: ProcessingState = {
      timestamp: Date.now(),
      processing: true,
      lockId,
    };
    await kv.put(key, JSON.stringify(state), {
      expirationTtl: IDEMPOTENCY_TTL_SECONDS,
    });

    // Write-then-verify pattern: Check if we actually own the lock
    // This mitigates (but doesn't eliminate) race conditions in eventually consistent KV
    // Skip cacheTtl here to get the freshest possible read after our write
    const verification = await kv.get<ProcessingState>(key, "json");

    if (verification && verification.lockId !== lockId) {
      // Another worker won the race - they wrote after us or our write wasn't first
      console.log(
        `[idempotency] Lost lock race for ${key}, another worker acquired it`
      );
      return { acquired: false, state: verification };
    }

    return { acquired: true, state };
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
 * Marks a commit as successfully processed. Updates the lock state to indicate
 * processing is complete and stores the checkRunId for reference.
 *
 * The TTL ensures old entries are eventually cleaned up, but completed entries
 * remain long enough to prevent duplicate processing from delayed webhooks.
 */
export const markCommitProcessed = async (
  kv: KVNamespace,
  repository: string,
  headSha: string,
  checkRunId?: number
): Promise<void> => {
  // Validate inputs (defense-in-depth)
  const validated = validateInputs(repository, headSha);
  if (!validated) {
    // Skip KV write for invalid inputs - this is non-critical
    return;
  }

  const key = buildKey(validated.repository, validated.headSha);
  const state: ProcessingState = {
    timestamp: Date.now(),
    processing: false,
    checkRunId,
  };

  try {
    await kv.put(key, JSON.stringify(state), {
      expirationTtl: IDEMPOTENCY_TTL_SECONDS,
    });
  } catch (error) {
    // Non-critical: DB is the ultimate source of truth for deduplication
    console.error("[idempotency] markCommitProcessed failed:", error);
  }
};

/**
 * Releases a lock when processing cannot complete (e.g., waiting for other runs).
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
