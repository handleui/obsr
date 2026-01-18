/**
 * Cron job to mark stuck heals as failed after a timeout period.
 *
 * Heals can get stuck in "pending" or "running" status if Modal crashes.
 * - Pending heals: 30 minutes (Modal should accept within seconds)
 * - Running heals: 30 minutes (Modal timeout is 5 minutes)
 *
 * Focus on autofix only (type='autofix'), not AI heals.
 */

import { createDb } from "../db/client";
import { markStaleHealsAsFailed } from "../db/operations/heals";
import type { Env } from "../types/env";

// Timeout in minutes for stale heal detection
const STALE_TIMEOUT_MINUTES = 30;

export interface CleanupJobResult {
  cleaned: number;
}

/**
 * Mark heals stuck in pending/running as failed after timeout.
 */
export const cleanupStaleHeals = async (
  env: Env
): Promise<CleanupJobResult> => {
  const { db, client } = await createDb(env);

  try {
    const cleaned = await markStaleHealsAsFailed(
      db,
      STALE_TIMEOUT_MINUTES,
      "autofix"
    );

    if (cleaned > 0) {
      console.log(
        `[cleanup-stale-heals] Marked ${cleaned} stale heals as failed`
      );
    }

    return { cleaned };
  } finally {
    await client.end();
  }
};
