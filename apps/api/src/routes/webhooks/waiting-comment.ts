import { createDb } from "../../db/client";
import { formatWaitingComment } from "../../services/comment-formatter";
import { createGitHubService } from "../../services/github";
import {
  acquirePrCommentLock,
  getStoredCommentId,
  releasePrCommentLock,
  storeCommentId,
} from "../../services/idempotency";
import { upsertCommentIdInDb } from "../../services/webhooks/db-operations";
import type { Env } from "../../types/env";

// ============================================================================
// Helper: Post "waiting" comment immediately when PR is created
// ============================================================================
// Posts a waiting comment to explain that Detent is monitoring CI.
// This comment will be updated with actual results when CI completes.

export interface PostWaitingCommentContext {
  env: Env;
  token: string;
  owner: string;
  repo: string;
  repository: string;
  prNumber: number;
  headSha: string;
  /** First line of the commit message from check_suite.head_commit.message */
  headCommitMessage?: string;
}

export const postWaitingComment = async (
  ctx: PostWaitingCommentContext
): Promise<void> => {
  const {
    env,
    token,
    owner,
    repo,
    repository,
    prNumber,
    headSha,
    headCommitMessage,
  } = ctx;
  const kv = env["detent-idempotency"];

  // Acquire lock to prevent race conditions when multiple workflows trigger simultaneously
  const lock = await acquirePrCommentLock(kv, repository, prNumber);
  if (!lock.acquired) {
    console.log(
      `[webhook] PR comment lock not acquired for ${repository}#${prNumber}, skipping waiting comment`
    );
    return;
  }

  try {
    const waitingBody = formatWaitingComment({ headSha, headCommitMessage });
    const github = createGitHubService(env);
    const shortSha = headSha.slice(0, 7);

    // Check if comment exists after acquiring lock (handles race condition)
    const existingCommentId = await getStoredCommentId(
      kv,
      repository,
      prNumber
    );
    if (existingCommentId) {
      // Update existing comment to show "waiting" for the new commit
      // This handles the case where a previous commit had results (pass/fail)
      // and a new commit is pushed - we want to show we're waiting on the new commit
      await github.updateComment(
        token,
        owner,
        repo,
        existingCommentId,
        waitingBody
      );
      console.log(
        `[webhook] Updated comment ${existingCommentId} to waiting state for ${shortSha} on ${repository}#${prNumber}`
      );
      return;
    }

    // Post new waiting comment if none exists

    const { id: commentId } = await github.postCommentWithId(
      token,
      owner,
      repo,
      prNumber,
      waitingBody
    );

    // Store comment ID in KV for later updates
    await storeCommentId(kv, repository, prNumber, commentId);

    // Store in DB for persistence
    const { db, client } = await createDb(env);
    try {
      await upsertCommentIdInDb(db, repository, prNumber, String(commentId));
    } finally {
      await client.end();
    }

    console.log(
      `[webhook] Posted waiting comment ${commentId} on ${repository}#${prNumber}`
    );
  } catch (error) {
    // Non-fatal - the comment will be created when workflow completes if this fails
    console.error("[webhook] Error posting waiting comment:", error);
  } finally {
    await releasePrCommentLock(kv, repository, prNumber);
  }
};
