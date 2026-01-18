import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFileContent, fetchFileContents } from "./file-content";
// biome-ignore lint/performance/noNamespaceImport: Required for vi.spyOn mocking
import * as rateLimitModule from "./rate-limit";

// Helper to create base64 encoded content (with newlines like GitHub does)
const toBase64WithNewlines = (content: string): string => {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  // Add newlines every 60 chars like GitHub does
  return base64.replace(/(.{60})/g, "$1\n");
};

const createContentsResponse = (
  path: string,
  content: string,
  sha = "abc123def456"
) => ({
  type: "file",
  encoding: "base64",
  size: content.length,
  name: path.split("/").pop(),
  path,
  content: toBase64WithNewlines(content),
  sha,
});

const createResponseWithRateLimitHeaders = (
  body: unknown,
  status = 200,
  remaining = 4900
) => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
};

// Store original to restore
const originalFetch = globalThis.fetch;
const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Helper to create a URL-based mock for parallel fetching */
const createUrlBasedMock = (responses: Map<string, Response>) => {
  mockFetch.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, response] of responses) {
      if (url.includes(pattern)) {
        return Promise.resolve(response.clone());
      }
    }
    return Promise.reject(new Error(`No mock for URL: ${url}`));
  });
};

describe("fetchFileContent", () => {
  it("fetches and decodes file content", async () => {
    const fileContent = "console.log('hello world');";
    mockFetch.mockResolvedValueOnce(
      createResponseWithRateLimitHeaders(
        createContentsResponse("src/index.ts", fileContent, "sha123456")
      )
    );

    const result = await fetchFileContent(
      "token",
      "owner",
      "repo",
      "src/index.ts",
      "abc1234567890123456789012345678901234567"
    );

    expect(result).toEqual({
      content: fileContent,
      path: "src/index.ts",
      sha: "sha123456",
      size: fileContent.length,
    });

    const [url, options] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/owner/repo/contents/src/index.ts?ref=abc1234567890123456789012345678901234567"
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

  it("returns null for 404 (file not found)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("Not Found", {
        status: 404,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4900",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
        },
      })
    );

    const result = await fetchFileContent(
      "token",
      "owner",
      "repo",
      "nonexistent.ts",
      "abc1234567890123456789012345678901234567"
    );

    expect(result).toBeNull();
  });

  it("handles UTF-8 content correctly", async () => {
    const utf8Content = "const emoji = '\u{1F680}'; // rocket";
    mockFetch.mockResolvedValueOnce(
      createResponseWithRateLimitHeaders(
        createContentsResponse("src/emoji.ts", utf8Content)
      )
    );

    const result = await fetchFileContent(
      "token",
      "owner",
      "repo",
      "src/emoji.ts",
      "abc1234567890123456789012345678901234567"
    );

    expect(result?.content).toBe(utf8Content);
  });

  it("encodes special characters in path", async () => {
    const fileContent = "test";
    mockFetch.mockResolvedValueOnce(
      createResponseWithRateLimitHeaders(
        createContentsResponse("path with spaces/file.ts", fileContent)
      )
    );

    await fetchFileContent(
      "token",
      "owner",
      "repo",
      "path with spaces/file.ts",
      "abc1234567890123456789012345678901234567"
    );

    const [url] = mockFetch.mock.calls[0] ?? [];
    expect(url).toContain("path%20with%20spaces");
  });

  it("throws on invalid owner/repo", async () => {
    await expect(
      fetchFileContent(
        "token",
        "../invalid",
        "repo",
        "file.ts",
        "abc1234567890123456789012345678901234567"
      )
    ).rejects.toThrow("Invalid owner or repo name");
  });

  it("throws on invalid SHA", async () => {
    await expect(
      fetchFileContent("token", "owner", "repo", "file.ts", "invalid-sha!")
    ).rejects.toThrow("Invalid SHA format");
  });

  it("throws on empty path", async () => {
    await expect(
      fetchFileContent(
        "token",
        "owner",
        "repo",
        "",
        "abc1234567890123456789012345678901234567"
      )
    ).rejects.toThrow("File path cannot be empty");
  });
});

describe("fetchFileContents", () => {
  it("fetches multiple files and deduplicates paths", async () => {
    const file1Content = "file 1";
    const file2Content = "file 2";

    // Use URL-based mock for parallel fetching
    // Note: paths are encoded segment-by-segment, so src/a.ts stays as src/a.ts in URL
    createUrlBasedMock(
      new Map([
        [
          "contents/src/a.ts",
          createResponseWithRateLimitHeaders(
            createContentsResponse("src/a.ts", file1Content)
          ),
        ],
        [
          "contents/src/b.ts",
          createResponseWithRateLimitHeaders(
            createContentsResponse("src/b.ts", file2Content)
          ),
        ],
      ])
    );

    // Request same file twice - should deduplicate
    const result = await fetchFileContents(
      "token",
      "owner",
      "repo",
      ["src/a.ts", "src/b.ts", "src/a.ts"],
      "abc1234567890123456789012345678901234567"
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(2);
    expect(result.get("src/a.ts")?.content).toBe(file1Content);
    expect(result.get("src/b.ts")?.content).toBe(file2Content);
  });

  it("handles 404 for some files gracefully", async () => {
    const fileContent = "existing file";

    // Use URL-based mock for parallel fetching
    createUrlBasedMock(
      new Map([
        [
          "exists.ts",
          createResponseWithRateLimitHeaders(
            createContentsResponse("exists.ts", fileContent)
          ),
        ],
        [
          "missing.ts",
          new Response("Not Found", {
            status: 404,
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4900",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
            },
          }),
        ],
      ])
    );

    const result = await fetchFileContents(
      "token",
      "owner",
      "repo",
      ["exists.ts", "missing.ts"],
      "abc1234567890123456789012345678901234567"
    );

    expect(result.size).toBe(1);
    expect(result.get("exists.ts")?.content).toBe(fileContent);
    expect(result.has("missing.ts")).toBe(false);
  });

  it("stops fetching when rate limit headroom exhausted between batches", async () => {
    // Create 7 unique file paths to span 2 batches (batch size is 5)
    const paths = [
      "src/1.ts",
      "src/2.ts",
      "src/3.ts",
      "src/4.ts",
      "src/5.ts",
      "src/6.ts",
      "src/7.ts",
    ];

    // Use URL-based mock for all possible files
    // Note: paths are encoded segment-by-segment, so src/1.ts stays as src/1.ts in URL
    const responses = new Map<string, Response>();
    for (let i = 1; i <= 7; i++) {
      responses.set(
        `contents/src/${i}.ts`,
        createResponseWithRateLimitHeaders(
          createContentsResponse(`src/${i}.ts`, `file ${i}`),
          200,
          4900
        )
      );
    }
    createUrlBasedMock(responses);

    // Mock hasRateLimitHeadroom to return false after first batch
    // Note: Set up spy AFTER vi.restoreAllMocks() in beforeEach has run
    const hasHeadroomSpy = vi.spyOn(rateLimitModule, "hasRateLimitHeadroom");
    hasHeadroomSpy.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await fetchFileContents(
      "token",
      "owner",
      "repo",
      paths,
      "abc1234567890123456789012345678901234567"
    );

    // First batch (5 files) should be fetched, second batch (2 files) should be skipped
    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(result.size).toBe(5);
    // First batch files present
    expect(result.get("src/1.ts")?.content).toBe("file 1");
    expect(result.get("src/5.ts")?.content).toBe("file 5");
    // Second batch files not present
    expect(result.has("src/6.ts")).toBe(false);
    expect(result.has("src/7.ts")).toBe(false);
  });

  it("returns empty map for empty paths array", async () => {
    const result = await fetchFileContents(
      "token",
      "owner",
      "repo",
      [],
      "abc1234567890123456789012345678901234567"
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});
