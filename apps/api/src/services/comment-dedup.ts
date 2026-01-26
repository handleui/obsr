import { deleteComment, listIssueComments } from "./github/comments";

// Deduplication runs in waitUntil (background) so we can use parallel deletion
// for better performance without blocking the response.
// Note: deleteAndPostComment in github/comments.ts uses sequential deletion
// because it runs in the main request path where simplicity is preferred.

interface DeduplicatePrCommentsOptions {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  storedCommentId: number;
  appId: number;
}

const getNewestCommentId = (comments: Array<{ id: number }>): number => {
  let newestId = comments[0]?.id ?? 0;
  for (const comment of comments) {
    if (comment.id > newestId) {
      newestId = comment.id;
    }
  }
  return newestId;
};

export const deduplicatePrComments = async (
  options: DeduplicatePrCommentsOptions
): Promise<{ deletedCount: number }> => {
  const { token, owner, repo, prNumber, storedCommentId, appId } = options;

  const comments = await listIssueComments(token, owner, repo, prNumber);
  const appComments = comments.filter(
    (comment) => comment.performed_via_github_app?.id === appId
  );

  if (appComments.length <= 1) {
    return { deletedCount: 0 };
  }

  const storedComment = appComments.find(
    (comment) => comment.id === storedCommentId
  );
  const keepCommentId = storedComment
    ? storedComment.id
    : getNewestCommentId(appComments);

  const commentsToDelete = appComments.filter(
    (comment) => comment.id !== keepCommentId
  );

  // Delete in parallel since this runs in background (waitUntil)
  // Use allSettled to continue even if some deletions fail
  const results = await Promise.allSettled(
    commentsToDelete.map((comment) =>
      deleteComment(token, owner, repo, comment.id)
    )
  );

  let deletedCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      deletedCount += 1;
    }
    // Failures are expected (404 = already deleted, race condition)
  }

  return { deletedCount };
};
