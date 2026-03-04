import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteComment, listIssueComments } from "./comments";

const mockFetch = vi.fn<typeof fetch>();

const createCommentResponse = (id: number, appId?: number) => ({
  id,
  body: `comment-${id}`,
  user: { login: `user-${id}`, type: "User" },
  performed_via_github_app: appId ? { id: appId } : null,
});

beforeEach(() => {
  mockFetch.mockReset();
  globalThis.fetch = mockFetch;
});

describe("listIssueComments", () => {
  it("fetches and maps issue comments", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([createCommentResponse(1, 456)]), {
        status: 200,
      })
    );

    const result = await listIssueComments("token", "owner", "repo", 42);

    expect(result).toEqual([
      {
        id: 1,
        body: "comment-1",
        user: { login: "user-1", type: "User" },
        performed_via_github_app: { id: 456 },
      },
    ]);

    const [url, options] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=1"
    );
    expect(options).toMatchObject({
      headers: {
        Authorization: "Bearer token",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Detent-App",
      },
    });
  });
});

describe("deleteComment", () => {
  it("deletes the specified comment", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deleteComment("token", "owner", "repo", 123);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/comments/123",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer token",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );
  });

  it("throws when delete fails", async () => {
    mockFetch.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    await expect(deleteComment("token", "owner", "repo", 456)).rejects.toThrow(
      "Failed to delete comment"
    );
  });
});
