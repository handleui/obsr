import { deleteComment, listIssueComments } from "./github/comments";

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

  let deletedCount = 0;
  for (const comment of commentsToDelete) {
    await deleteComment(token, owner, repo, comment.id);
    deletedCount += 1;
  }

  return { deletedCount };
};
