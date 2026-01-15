import { beforeEach, describe, expect, it, vi } from "vitest";
import { deduplicatePrComments } from "./comment-dedup";
import { deleteComment, listIssueComments } from "./github/comments";

vi.mock("./github/comments", () => ({
  listIssueComments: vi.fn(),
  deleteComment: vi.fn(),
}));

const mockListIssueComments = vi.mocked(listIssueComments);
const mockDeleteComment = vi.mocked(deleteComment);

const createComment = (id: number, appId?: number) => ({
  id,
  body: `comment-${id}`,
  user: { login: `user-${id}`, type: "Bot" },
  performed_via_github_app: appId ? { id: appId } : null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deduplicatePrComments", () => {
  it("returns early when there is only one app comment", async () => {
    mockListIssueComments.mockResolvedValueOnce([
      createComment(10, 123),
      createComment(11),
    ]);

    const result = await deduplicatePrComments({
      token: "token",
      owner: "owner",
      repo: "repo",
      prNumber: 7,
      storedCommentId: 10,
      appId: 123,
    });

    expect(result).toEqual({ deletedCount: 0 });
    expect(mockDeleteComment).not.toHaveBeenCalled();
  });

  it("keeps the stored comment and deletes the rest", async () => {
    mockListIssueComments.mockResolvedValueOnce([
      createComment(10, 123),
      createComment(11, 123),
      createComment(12, 123),
    ]);

    const result = await deduplicatePrComments({
      token: "token",
      owner: "owner",
      repo: "repo",
      prNumber: 7,
      storedCommentId: 11,
      appId: 123,
    });

    expect(result).toEqual({ deletedCount: 2 });
    expect(mockDeleteComment).toHaveBeenCalledTimes(2);
    expect(mockDeleteComment).toHaveBeenNthCalledWith(
      1,
      "token",
      "owner",
      "repo",
      10
    );
    expect(mockDeleteComment).toHaveBeenNthCalledWith(
      2,
      "token",
      "owner",
      "repo",
      12
    );
  });

  it("keeps the newest comment when stored ID is missing", async () => {
    mockListIssueComments.mockResolvedValueOnce([
      createComment(5, 123),
      createComment(9, 123),
    ]);

    const result = await deduplicatePrComments({
      token: "token",
      owner: "owner",
      repo: "repo",
      prNumber: 7,
      storedCommentId: 100,
      appId: 123,
    });

    expect(result).toEqual({ deletedCount: 1 });
    expect(mockDeleteComment).toHaveBeenCalledTimes(1);
    expect(mockDeleteComment).toHaveBeenCalledWith("token", "owner", "repo", 5);
  });
});
