/**
 * Cron job to mark stuck resolves as failed after a timeout period.
 *
 * Resolves can get stuck in "pending" or "running" status if Modal crashes.
 * - Pending resolves: 30 minutes (Modal should accept within seconds)
 * - Running resolves: 30 minutes (Modal timeout is 5 minutes)
 *
 * Focus on autofix only (type='autofix'), not AI resolves.
 */

import { markStaleResolvesAsFailed } from "../db/operations/resolves";
import type { Env } from "../types/env";

// Timeout in minutes for stale resolve detection
const STALE_TIMEOUT_MINUTES = 30;

export interface CleanupJobResult {
  cleaned: number;
}

/**
 * Mark resolves stuck in pending/running as failed after timeout.
 */
export const cleanupStaleResolves = async (
  env: Env
): Promise<CleanupJobResult> => {
  const cleaned = await markStaleResolvesAsFailed(
    env,
    STALE_TIMEOUT_MINUTES,
    "autofix"
  );

  if (cleaned > 0) {
    console.log(
      `[cleanup-stale-resolves] Marked ${cleaned} stale resolves as failed`
    );
  }

  return { cleaned };
};
