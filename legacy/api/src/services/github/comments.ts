import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import {
  formatPassingComment,
  type WorkflowRunResult,
} from "../comment-formatter";
import { getStoredCommentId, storeCommentId } from "../idempotency";
import {
  getCommentIdFromDb,
  upsertCommentIdInDb,
} from "../webhooks/db-operations";
import type { DbClient } from "../webhooks/types";
import {
  GITHUB_API,
  validateCommentId,
  validateIssueNumber,
  validateOwnerRepo,
} from "./validation";

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string; type: string };
  performed_via_github_app: { id: number } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const parseIssueComment = (value: unknown, context: string): IssueComment => {
  if (!isRecord(value)) {
    throw new Error(`${context}: Unexpected comment format`);
  }

  const idValue = value.id;
  if (typeof idValue !== "number") {
    throw new Error(`${context}: Comment missing id`);
  }

  const bodyValue = typeof value.body === "string" ? value.body : "";
  const userValue = isRecord(value.user) ? value.user : null;
  const login =
    userValue && typeof userValue.login === "string"
      ? userValue.login
      : "unknown";
  const type =
    userValue && typeof userValue.type === "string" ? userValue.type : "User";

  let performedVia: { id: number } | null = null;
  if (isRecord(value.performed_via_github_app)) {
    const appId = value.performed_via_github_app.id;
    if (typeof appId === "number") {
      performedVia = { id: appId };
    }
  }

  return {
    id: idValue,
    body: bodyValue,
    user: { login, type },
    performed_via_github_app: performedVia,
  };
};

export const listIssueComments = async (
  token: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<IssueComment[]> => {
  const context = `listIssueComments(${owner}/${repo}#${issueNumber})`;

  validateOwnerRepo(owner, repo, context);
  validateIssueNumber(issueNumber, context);

  const perPage = 100;
  let page = 1;
  const comments: IssueComment[] = [];

  while (true) {
    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `${context}: Failed to list issue comments - ${response.status} ${error}`
      );
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error(`${context}: Unexpected response format`);
    }

    for (const item of data) {
      comments.push(parseIssueComment(item, context));
    }

    if (data.length < perPage) {
      break;
    }

    page += 1;
  }

  return comments;
};

export const deleteComment = async (
  token: string,
  owner: string,
  repo: string,
  commentId: number
): Promise<void> => {
  const context = `deleteComment(${owner}/${repo}, commentId=${commentId})`;

  validateOwnerRepo(owner, repo, context);
  validateCommentId(commentId, context);

  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Detent-App",
      },
    }
  );

  if (response.status !== 204) {
    const error = await response.text();
    throw new Error(
      `${context}: Failed to delete comment - ${response.status} ${error}`
    );
  }
};

interface GitHubCommentClient {
  updateComment: (
    token: string,
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ) => Promise<void>;
  postCommentWithId: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ) => Promise<{ id: number }>;
}

export interface PostCommentContext {
  github: GitHubCommentClient;
  token: string;
  kv: KVNamespace;
  db: DbClient;
  executionCtx?: ExecutionContext;
  owner: string;
  repo: string;
  repository: string;
  prNumber: number;
  commentBody: string;
  appId: number;
}

export const postOrUpdateComment = async (
  ctx: PostCommentContext
): Promise<void> => {
  const { kv, db, repository, prNumber } = ctx;

  let existingCommentId = await getStoredCommentId(kv, repository, prNumber);
  let commentSource = "kv";

  if (!existingCommentId) {
    const dbCommentId = await getCommentIdFromDb(db, repository, prNumber);
    if (dbCommentId) {
      existingCommentId = Number.parseInt(dbCommentId, 10);
      commentSource = "db";
      console.log(
        `[workflow_run] Found comment ID ${existingCommentId} in DB (KV miss) for PR #${prNumber}`
      );
    }
  }

  if (existingCommentId) {
    await updateExistingComment(ctx, existingCommentId, commentSource);
  } else {
    await createNewComment(ctx);
  }
};

const updateExistingComment = async (
  ctx: PostCommentContext,
  commentId: number,
  source: string
): Promise<void> => {
  const { github, token, kv, owner, repo, repository, prNumber, commentBody } =
    ctx;

  try {
    await github.updateComment(token, owner, repo, commentId, commentBody);
    console.log(
      `[workflow_run] Updated existing comment ${commentId} on PR #${prNumber} (source: ${source})`
    );
    if (source === "db") {
      await storeCommentId(kv, repository, prNumber, commentId);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isNotFound =
      errorMessage.includes("404") || errorMessage.includes("not found");

    if (isNotFound) {
      console.log(
        `[workflow_run] Comment ${commentId} was deleted, creating new comment for PR #${prNumber}`
      );
      await createNewComment(ctx);
    } else {
      throw error;
    }
  }
};

const createNewComment = async (ctx: PostCommentContext): Promise<void> => {
  const {
    github,
    token,
    kv,
    db,
    executionCtx,
    owner,
    repo,
    repository,
    prNumber,
    commentBody,
    appId,
  } = ctx;

  const { id: newCommentId } = await github.postCommentWithId(
    token,
    owner,
    repo,
    prNumber,
    commentBody
  );
  await storeCommentId(kv, repository, prNumber, newCommentId);
  await upsertCommentIdInDb(db, repository, prNumber, String(newCommentId));
  console.log(
    `[workflow_run] Posted new comment ${newCommentId} on PR #${prNumber}`
  );
  if (Number.isInteger(appId) && appId > 0) {
    const { deduplicatePrComments } = await import("../comment-dedup");
    const dedupTask = deduplicatePrComments({
      token,
      owner,
      repo,
      prNumber,
      storedCommentId: newCommentId,
      appId,
    }).catch((error) => {
      console.error("[dedup] Failed:", error);
    });

    if (executionCtx) {
      executionCtx.waitUntil(dedupTask);
    }
  }
};

export interface UpdatePassingCommentContext {
  github: GitHubCommentClient;
  token: string;
  kv: KVNamespace;
  db: DbClient;
  owner: string;
  repo: string;
  repository: string;
  prNumber: number;
  headSha: string;
  headCommitMessage?: string;
  runs: WorkflowRunResult[];
}

export const updateCommentToPassingState = async (
  ctx: UpdatePassingCommentContext
): Promise<boolean> => {
  const {
    github,
    token,
    kv,
    db,
    owner,
    repo,
    repository,
    prNumber,
    headSha,
    headCommitMessage,
    runs,
  } = ctx;

  let existingCommentId = await getStoredCommentId(kv, repository, prNumber);

  if (!existingCommentId) {
    const dbCommentId = await getCommentIdFromDb(db, repository, prNumber);
    if (dbCommentId) {
      existingCommentId = Number.parseInt(dbCommentId, 10);
    }
  }

  if (!existingCommentId) {
    console.log(
      `[workflow_run] All checks passed - no existing comment to update for PR #${prNumber}`
    );
    return false;
  }

  const passingBody = formatPassingComment({
    runs,
    headSha,
    headCommitMessage,
  });

  try {
    await github.updateComment(
      token,
      owner,
      repo,
      existingCommentId,
      passingBody
    );
    console.log(
      `[workflow_run] Updated comment ${existingCommentId} to passing state for PR #${prNumber}`
    );
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isNotFound =
      errorMessage.includes("404") || errorMessage.includes("not found");
    if (isNotFound) {
      console.log(
        `[workflow_run] Comment ${existingCommentId} was deleted, skipping passing comment for PR #${prNumber}`
      );
      return false;
    }
    throw error;
  }
};

// ============================================================================
// Delete and Post Comment
// ============================================================================
// Deletes ALL previous Detent comments and posts a new one.
// This ensures a clean slate on each new CI run.
//
// Performance analysis:
// - API calls: 1 list (paginated) + N deletes + 1 post = O(N+2) calls
// - Typical case: 1-3 app comments per PR, so overhead is minimal
// - Pagination: listIssueComments handles 100+ comments via pagination
//
// Rate limits (GitHub REST API):
// - Primary: 5,000 requests/hour (authenticated)
// - Secondary: 900 points/min, 100 concurrent requests max
// - DELETE requests don't count toward content-generation limits (80/min)
//
// Design decisions:
// - Sequential deletion: Used here because this runs in the main request path.
//   Keeping it sequential simplifies error handling and avoids potential race
//   conditions. Note: comment-dedup.ts uses parallel deletion because it runs
//   in waitUntil (background), where parallel execution is acceptable.
// - Error handling: Continue on delete failure (comment may be already deleted)

export interface DeleteAndPostCommentContext {
  github: GitHubCommentClient;
  token: string;
  kv: KVNamespace;
  db: DbClient;
  owner: string;
  repo: string;
  repository: string;
  prNumber: number;
  commentBody: string;
  appId: number;
}

export const deleteAndPostComment = async (
  ctx: DeleteAndPostCommentContext
): Promise<{ commentId: number }> => {
  const {
    github,
    token,
    kv,
    db,
    owner,
    repo,
    repository,
    prNumber,
    commentBody,
    appId,
  } = ctx;

  // Delete ALL Detent comments on this PR (not just the stored one)
  // This ensures we clear orphaned comments from retries, race conditions, etc.
  if (Number.isInteger(appId) && appId > 0) {
    const comments = await listIssueComments(token, owner, repo, prNumber);
    const appComments = comments.filter(
      (comment) => comment.performed_via_github_app?.id === appId
    );

    let deletedCount = 0;
    let failedCount = 0;
    for (const comment of appComments) {
      try {
        await deleteComment(token, owner, repo, comment.id);
        deletedCount += 1;
      } catch (error) {
        // Continue on delete errors - comment may already be deleted by concurrent request
        // or user may have deleted it manually
        const errorMsg = error instanceof Error ? error.message : String(error);
        const is404 = errorMsg.includes("404");
        if (!is404) {
          console.log(`[comment] Delete failed for ${comment.id}: ${errorMsg}`);
        }
        failedCount += 1;
      }
    }

    if (deletedCount > 0 || failedCount > 0) {
      console.log(
        `[comment] Cleanup: deleted=${deletedCount} failed=${failedCount} on PR #${prNumber}`
      );
    }
  } else {
    // SECURITY: Log warning if appId is invalid - this could leave orphaned comments
    // The appId comes from GITHUB_APP_ID env var. If misconfigured, we skip app-based
    // filtering but still proceed with posting. This is intentional to avoid breaking
    // functionality, but the warning helps operators identify the misconfiguration.
    console.warn(
      `[comment] Invalid appId (${appId}) - skipping orphaned comment cleanup for PR #${prNumber}. ` +
        "Check GITHUB_APP_ID environment variable."
    );
  }

  // Post new comment
  const { id: newCommentId } = await github.postCommentWithId(
    token,
    owner,
    repo,
    prNumber,
    commentBody
  );

  // Store new comment ID for future updates
  await storeCommentId(kv, repository, prNumber, newCommentId);
  await upsertCommentIdInDb(db, repository, prNumber, String(newCommentId));

  console.log(
    `[comment] Posted new comment ${newCommentId} on PR #${prNumber}`
  );

  return { commentId: newCommentId };
};
