import type { CIError } from "@obsr/legacy-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichErrorsWithFileContext } from "./error-enrichment";
// biome-ignore lint/performance/noNamespaceImport: Required for vi.spyOn mocking
import * as fileContentModule from "./github/file-content";

// Use spyOn instead of vi.mock to avoid module contamination across test files
const mockFetchFileContents = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Spy on the actual module function
  vi.spyOn(fileContentModule, "fetchFileContents").mockImplementation(
    mockFetchFileContents
  );
});

// Mock file content for testing
const mockFileContent = (lines: string[]): string => lines.join("\n");

const createMockError = (overrides: Partial<CIError> = {}): CIError => ({
  message: "Test error",
  filePath: "src/index.ts",
  line: 10,
  ...overrides,
});

const defaultCtx = {
  owner: "testowner",
  repo: "testrepo",
  commitSha: "abc123def456",
  token: "test-token",
};

describe("enrichErrorsWithFileContext", () => {
  it("enriches errors with snippets", async () => {
    mockFetchFileContents.mockResolvedValue(
      new Map([
        [
          "src/index.ts",
          {
            content: mockFileContent([
              "line 1",
              "line 2",
              "line 3",
              "line 4",
              "line 5",
              "line 6",
              "line 7",
              "line 8",
              "line 9",
              "line 10 - error here",
              "line 11",
              "line 12",
              "line 13",
            ]),
            path: "src/index.ts",
            sha: "filesha123",
            size: 100,
          },
        ],
      ])
    );

    const errors: CIError[] = [
      createMockError({ message: "Error on line 10", line: 10 }),
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.codeSnippet).toBeDefined();
    expect(result.errors[0]?.codeSnippet?.startLine).toBe(7);
    expect(result.errors[0]?.codeSnippet?.errorLine).toBe(4); // 10 - 7 + 1 = 4
    expect(result.errors[0]?.codeSnippet?.lines).toHaveLength(7);
    expect(result.errors[0]?.codeSnippet?.language).toBe("typescript");
    expect(result.stats.enriched).toBe(1);
    expect(result.stats.total).toBe(1);
  });

  it("skips errors without location", async () => {
    mockFetchFileContents.mockResolvedValue(new Map());

    const errors: CIError[] = [
      createMockError({ filePath: undefined, line: undefined }),
      createMockError({ filePath: "src/file.ts", line: undefined }),
      createMockError({ filePath: undefined, line: 5 }),
      createMockError({ filePath: "src/file.ts", line: 0 }),
      createMockError({ filePath: "src/file.ts", line: -1 }),
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    expect(result.stats.noLocation).toBe(5);
    expect(result.stats.enriched).toBe(0);
    // Should not fetch any files
    expect(mockFetchFileContents).not.toHaveBeenCalled();
  });

  it("skips errors that already have snippets", async () => {
    mockFetchFileContents.mockResolvedValue(new Map());

    const errors: CIError[] = [
      createMockError({
        codeSnippet: {
          lines: ["existing snippet"],
          startLine: 1,
          errorLine: 1,
          language: "typescript",
        },
      }),
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    expect(result.stats.alreadyHasSnippet).toBe(1);
    expect(result.stats.enriched).toBe(0);
    expect(result.errors[0]?.codeSnippet?.lines).toEqual(["existing snippet"]);
    expect(mockFetchFileContents).not.toHaveBeenCalled();
  });

  it("skips sensitive files", async () => {
    mockFetchFileContents.mockResolvedValue(new Map());

    const errors: CIError[] = [
      createMockError({ filePath: ".env", line: 1 }),
      createMockError({ filePath: ".env.local", line: 1 }),
      createMockError({ filePath: "config/.env.production", line: 1 }),
      createMockError({ filePath: "credentials.json", line: 1 }),
      createMockError({ filePath: "secrets/api-key.txt", line: 1 }),
      createMockError({ filePath: "path/to/private/config.ts", line: 1 }),
      createMockError({ filePath: "cert.pem", line: 1 }),
      createMockError({ filePath: ".ssh/config", line: 1 }),
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    expect(result.stats.sensitiveFile).toBe(8);
    expect(result.stats.enriched).toBe(0);
    expect(mockFetchFileContents).not.toHaveBeenCalled();
  });

  it("prioritizes files by error count", async () => {
    let capturedPaths: string[] = [];
    mockFetchFileContents.mockImplementation(
      (_token: string, _owner: string, _repo: string, paths: string[]) => {
        capturedPaths = [...paths];
        return Promise.resolve(new Map());
      }
    );

    const errors: CIError[] = [
      // file-a.ts has 3 errors
      createMockError({ filePath: "file-a.ts", line: 1 }),
      createMockError({ filePath: "file-a.ts", line: 2 }),
      createMockError({ filePath: "file-a.ts", line: 3 }),
      // file-b.ts has 1 error
      createMockError({ filePath: "file-b.ts", line: 1 }),
      // file-c.ts has 2 errors
      createMockError({ filePath: "file-c.ts", line: 1 }),
      createMockError({ filePath: "file-c.ts", line: 2 }),
    ];

    await enrichErrorsWithFileContext(errors, defaultCtx);

    // Should be ordered by error count descending
    expect(capturedPaths[0]).toBe("file-a.ts"); // 3 errors
    expect(capturedPaths[1]).toBe("file-c.ts"); // 2 errors
    expect(capturedPaths[2]).toBe("file-b.ts"); // 1 error
  });

  it("prioritizes non-test files over test files with same error count", async () => {
    let capturedPaths: string[] = [];
    mockFetchFileContents.mockImplementation(
      (_token: string, _owner: string, _repo: string, paths: string[]) => {
        capturedPaths = [...paths];
        return Promise.resolve(new Map());
      }
    );

    const errors: CIError[] = [
      createMockError({ filePath: "src/utils.test.ts", line: 1 }),
      createMockError({ filePath: "src/utils.ts", line: 1 }),
      createMockError({ filePath: "__tests__/helper.ts", line: 1 }),
      createMockError({ filePath: "src/helper.ts", line: 1 }),
      createMockError({ filePath: "test/integration.spec.ts", line: 1 }),
    ];

    await enrichErrorsWithFileContext(errors, defaultCtx);

    // Non-test files should come first (first 2 items)
    const nonTestFiles = capturedPaths.slice(0, 2);
    expect(nonTestFiles).toContain("src/utils.ts");
    expect(nonTestFiles).toContain("src/helper.ts");

    // Test files after (remaining 3 items)
    const testFiles = capturedPaths.slice(2);
    expect(testFiles).toContain("src/utils.test.ts");
    expect(testFiles).toContain("__tests__/helper.ts");
    expect(testFiles).toContain("test/integration.spec.ts");
  });

  it("limits to MAX_FILES_TO_FETCH", async () => {
    let capturedPaths: string[] = [];
    mockFetchFileContents.mockImplementation(
      (_token: string, _owner: string, _repo: string, paths: string[]) => {
        capturedPaths = [...paths];
        return Promise.resolve(new Map());
      }
    );

    // Create 25 errors in different files
    const errors: CIError[] = [];
    for (let i = 0; i < 25; i++) {
      errors.push(createMockError({ filePath: `file-${i}.ts`, line: 1 }));
    }

    await enrichErrorsWithFileContext(errors, defaultCtx);

    // Should only request 20 files (MAX_FILES_TO_FETCH)
    expect(capturedPaths).toHaveLength(20);
  });

  it("handles rate-limited files", async () => {
    // Simulate fetchFileContents returning partial results due to rate limiting
    mockFetchFileContents.mockResolvedValue(
      new Map([
        [
          "src/file-a.ts",
          {
            content: "line 1\nline 2\nline 3",
            path: "src/file-a.ts",
            sha: "sha1",
            size: 20,
          },
        ],
        // file-b.ts not returned (rate limited)
      ])
    );

    const errors: CIError[] = [
      createMockError({ filePath: "src/file-a.ts", line: 2 }),
      createMockError({ filePath: "src/file-b.ts", line: 2 }),
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    expect(result.stats.enriched).toBe(1);
    expect(result.stats.skippedRateLimit).toBe(1);
    expect(result.errors[0]?.codeSnippet).toBeDefined();
    expect(result.errors[1]?.codeSnippet).toBeUndefined();
  });

  it("handles file content extraction failure", async () => {
    mockFetchFileContents.mockResolvedValue(
      new Map([
        [
          "src/empty.ts",
          {
            content: "", // Empty file
            path: "src/empty.ts",
            sha: "sha1",
            size: 0,
          },
        ],
      ])
    );

    const errors: CIError[] = [
      createMockError({ filePath: "src/empty.ts", line: 10 }), // Line doesn't exist
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    expect(result.stats.failed).toBe(1);
    expect(result.stats.enriched).toBe(0);
  });

  it("detects language from file extension", async () => {
    mockFetchFileContents.mockResolvedValue(
      new Map([
        [
          "src/app.py",
          {
            content: "def hello():\n    print('hello')\n    return True",
            path: "src/app.py",
            sha: "sha1",
            size: 50,
          },
        ],
        [
          "lib/utils.go",
          {
            content: "package main\n\nfunc main() {\n    fmt.Println()\n}",
            path: "lib/utils.go",
            sha: "sha2",
            size: 50,
          },
        ],
      ])
    );

    const errors: CIError[] = [
      createMockError({ filePath: "src/app.py", line: 2 }),
      createMockError({ filePath: "lib/utils.go", line: 3 }),
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    expect(result.errors[0]?.codeSnippet?.language).toBe("python");
    expect(result.errors[1]?.codeSnippet?.language).toBe("go");
  });

  it("truncates long lines", async () => {
    const longLine = "x".repeat(600);
    mockFetchFileContents.mockResolvedValue(
      new Map([
        [
          "src/long.ts",
          {
            content: `line 1\n${longLine}\nline 3`,
            path: "src/long.ts",
            sha: "sha1",
            size: 610,
          },
        ],
      ])
    );

    const errors: CIError[] = [
      createMockError({ filePath: "src/long.ts", line: 2 }),
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    const snippet = result.errors[0]?.codeSnippet;
    expect(snippet).toBeDefined();
    // Line should be truncated to ~500 chars + "..."
    expect(snippet?.lines[1]?.length).toBeLessThanOrEqual(503);
    expect(snippet?.lines[1]?.endsWith("...")).toBe(true);
  });

  it("correctly calculates snippet line numbers for edge cases", async () => {
    mockFetchFileContents.mockResolvedValue(
      new Map([
        [
          "src/short.ts",
          {
            content: "line 1\nline 2\nline 3",
            path: "src/short.ts",
            sha: "sha1",
            size: 25,
          },
        ],
      ])
    );

    // Error on line 1 (edge case - start of file)
    const errors: CIError[] = [
      createMockError({ filePath: "src/short.ts", line: 1 }),
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    expect(result.errors[0]?.codeSnippet?.startLine).toBe(1);
    expect(result.errors[0]?.codeSnippet?.errorLine).toBe(1);
  });

  it("returns correct stats", async () => {
    mockFetchFileContents.mockResolvedValue(
      new Map([
        [
          "src/index.ts",
          {
            content: "line 1\nline 2\nline 3\nline 4\nline 5",
            path: "src/index.ts",
            sha: "sha1",
            size: 35,
          },
        ],
      ])
    );

    const errors: CIError[] = [
      createMockError({ filePath: "src/index.ts", line: 2 }), // Will be enriched
      createMockError({ filePath: undefined }), // No location
      createMockError({
        codeSnippet: {
          lines: ["x"],
          startLine: 1,
          errorLine: 1,
          language: "ts",
        },
      }), // Already has snippet
      createMockError({ filePath: ".env", line: 1 }), // Sensitive
      createMockError({ filePath: "src/missing.ts", line: 1 }), // File not fetched
    ];

    const result = await enrichErrorsWithFileContext(errors, defaultCtx);

    expect(result.stats.total).toBe(5);
    expect(result.stats.enriched).toBe(1);
    expect(result.stats.noLocation).toBe(1);
    expect(result.stats.alreadyHasSnippet).toBe(1);
    expect(result.stats.sensitiveFile).toBe(1);
    expect(result.stats.skippedRateLimit).toBe(1);
    expect(result.stats.uniqueFilesRequested).toBe(2);
    expect(result.stats.uniqueFilesFetched).toBe(1);
  });
});
