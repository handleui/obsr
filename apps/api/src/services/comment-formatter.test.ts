import { describe, expect, it } from "vitest";
import {
  formatCheckRunOutput,
  formatCheckSummary,
  formatPassingComment,
  formatResultsComment,
  formatWaitingComment,
} from "./comment-formatter";

// Top-level regex for performance (lint rule: useTopLevelRegex)
const TIMESTAMP_PATTERN = /\w+ \d+, \d{2}:\d{2} UTC/;

// Factory for creating test options
const createOptions = (
  overrides: Partial<Parameters<typeof formatResultsComment>[0]> = {}
) => ({
  owner: "test-owner",
  repo: "test-repo",
  headSha: "abc1234567890def",
  runs: [],
  errors: [],
  totalErrors: 0,
  ...overrides,
});

describe("formatResultsComment", () => {
  describe("edge cases", () => {
    it("returns null when no workflows fail", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
            { name: "Test", id: 456, conclusion: "success", errorCount: 0 },
          ],
        })
      );

      expect(result).toBeNull();
    });

    it("returns null when all workflows are cancelled/skipped", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "cancelled", errorCount: 0 },
            { name: "Test", id: 456, conclusion: "skipped", errorCount: 0 },
          ],
        })
      );

      expect(result).toBeNull();
    });

    it("returns null with empty runs array", () => {
      const result = formatResultsComment(createOptions({ runs: [] }));

      expect(result).toBeNull();
    });

    it("shows skipped count when workflows are cancelled/skipped", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 3 },
            { name: "Test", id: 456, conclusion: "cancelled", errorCount: 0 },
            { name: "Deploy", id: 789, conclusion: "skipped", errorCount: 0 },
          ],
        })
      );

      expect(result).toContain("2 skipped");
    });
  });

  describe("list format", () => {
    it("includes friendly Detent header for errors", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 3 },
          ],
        })
      );

      expect(result).toContain("Detent found some issues in your CI");
      expect(result).toContain("Read the docs](https://detent.sh/docs)");
    });

    it("shows only failed workflows in the list", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 3 },
            { name: "Test", id: 456, conclusion: "success", errorCount: 0 },
            { name: "Lint", id: 789, conclusion: "failure", errorCount: 2 },
          ],
        })
      );

      // Failed workflows should be shown
      expect(result).toContain("**Build**");
      expect(result).toContain("**Lint**");

      // Passed workflows should NOT be shown (only in footer count)
      expect(result).not.toContain("**Test**");
    });

    it("includes view link in header when checkRunId provided", () => {
      const result = formatResultsComment(
        createOptions({
          owner: "my-org",
          repo: "my-repo",
          headSha: "abc1234567890def",
          runs: [
            { name: "Build", id: 12_345, conclusion: "failure", errorCount: 3 },
          ],
          checkRunId: 98_765,
        })
      );

      // Header should have view link and CLI command
      expect(result).toContain(
        "CI · [view](https://github.com/my-org/my-repo/runs/98765) · `dt errors --commit abc1234`"
      );
    });

    it("omits view link from header when checkRunId is not provided", () => {
      const result = formatResultsComment(
        createOptions({
          owner: "my-org",
          repo: "my-repo",
          headSha: "abc1234567890def",
          runs: [
            { name: "Build", id: 12_345, conclusion: "failure", errorCount: 3 },
          ],
        })
      );

      // Header should only have CI and CLI command (no view link)
      expect(result).toContain("CI · `dt errors --commit abc1234`");
      expect(result).not.toContain("[view]");
    });

    it("shows error count per workflow in fallback mode", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 5 },
          ],
        })
      );

      expect(result).toContain("5 errors");
    });

    it("shows step-level errors when job/step info is available", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [{ name: "CI", id: 123, conclusion: "failure", errorCount: 5 }],
          errors: [
            {
              message: "Error 1",
              workflowJob: "CI",
              workflowContext: { step: "test" },
            },
            {
              message: "Error 2",
              workflowJob: "CI",
              workflowContext: { step: "test" },
            },
            {
              message: "Error 3",
              workflowJob: "CI",
              workflowContext: { step: "lint" },
            },
          ],
        })
      );

      // Should show job header
      expect(result).toContain("**CI**");
      // Should show steps as bullet points (bold, not backticks, to avoid formatting issues)
      expect(result).toContain("- **test** · 2 errors");
      expect(result).toContain("- **lint** · 1 error");
    });

    it("falls back to legacy workflowStep field when workflowContext.step is missing", () => {
      // Simulate errors coming from DB with workflowStep instead of workflowContext.step
      const result = formatResultsComment(
        createOptions({
          runs: [{ name: "CI", id: 123, conclusion: "failure", errorCount: 2 }],
          errors: [
            {
              message: "Error 1",
              workflowJob: "CI",
              workflowStep: "build",
            } as Parameters<typeof formatResultsComment>[0]["errors"][number],
            {
              message: "Error 2",
              workflowJob: "CI",
              workflowStep: "test",
            } as Parameters<typeof formatResultsComment>[0]["errors"][number],
          ],
        })
      );

      // Should show steps from legacy workflowStep field
      expect(result).toContain("- **build** · 1 error");
      expect(result).toContain("- **test** · 1 error");
    });
  });

  describe("footer", () => {
    it("shows passed workflow count when some pass", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 3 },
            { name: "Test", id: 456, conclusion: "success", errorCount: 0 },
            { name: "Lint", id: 789, conclusion: "success", errorCount: 0 },
          ],
        })
      );

      expect(result).toContain("2 passed");
    });

    it("omits passed count when no workflows pass", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 3 },
          ],
        })
      );

      expect(result).not.toContain("passed");
    });

    it("includes UTC timestamp in 24h format", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 1 },
          ],
        })
      );

      expect(result).toContain("UTC");
      // Should use 24h format (e.g., "Jan 12, 15:30")
      expect(result).toMatch(TIMESTAMP_PATTERN);
    });

    it("includes short SHA in footer", () => {
      const result = formatResultsComment(
        createOptions({
          headSha: "abc1234567890def",
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 1 },
          ],
        })
      );

      expect(result).toContain("`abc1234`");
    });

    it("includes commit message when provided", () => {
      const result = formatResultsComment(
        createOptions({
          headSha: "abc1234567890def",
          headCommitMessage: "fix: improve error handling",
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 1 },
          ],
        })
      );

      expect(result).toContain("`abc1234` fix: improve error handling");
    });

    it("truncates long commit messages", () => {
      const result = formatResultsComment(
        createOptions({
          headSha: "abc1234567890def",
          headCommitMessage:
            "feat: this is a very long commit message that should be truncated to keep the footer readable",
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 1 },
          ],
        })
      );

      // Should be truncated with ellipsis
      expect(result).toContain("…");
      expect(result).not.toContain("readable");
    });

    it("uses middle dot separator between footer elements", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 3 },
            { name: "Test", id: 456, conclusion: "success", errorCount: 0 },
          ],
        })
      );

      expect(result).toContain(" · ");
    });

    it("includes CLI command in header", () => {
      const result = formatResultsComment(
        createOptions({
          headSha: "abc1234567890def",
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 1 },
          ],
        })
      );

      // CLI command should be in the header line
      expect(result).toContain("CI · `dt errors --commit abc1234`");
    });
  });

  describe("html escaping", () => {
    it("escapes HTML in workflow names", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            {
              name: "<script>alert('xss')</script>",
              id: 123,
              conclusion: "failure",
              errorCount: 1,
            },
          ],
        })
      );

      // HTML should be escaped
      expect(result).not.toContain("<script>");
      expect(result).toContain("&lt;script&gt;");
    });
  });
});

describe("formatCheckSummary", () => {
  it("shows correct pluralization for single failure", () => {
    const result = formatCheckSummary(
      [{ name: "build", id: 1, conclusion: "failure", errorCount: 1 }],
      1
    );

    expect(result).toContain("1 workflow failed");
    expect(result).toContain("1 error");
    expect(result).not.toContain("workflows");
    expect(result).not.toContain("errors");
  });

  it("shows correct pluralization for multiple failures", () => {
    const result = formatCheckSummary(
      [
        { name: "build", id: 1, conclusion: "failure", errorCount: 2 },
        { name: "lint", id: 2, conclusion: "failure", errorCount: 3 },
      ],
      5
    );

    expect(result).toContain("2 workflows failed");
    expect(result).toContain("5 errors");
  });

  it("shows success message when all workflows pass", () => {
    const result = formatCheckSummary(
      [
        { name: "build", id: 1, conclusion: "success", errorCount: 0 },
        { name: "lint", id: 2, conclusion: "success", errorCount: 0 },
      ],
      0
    );

    expect(result).toContain("All workflows passed");
    expect(result).not.toContain("failed");
  });

  it("shows passed count when some workflows pass", () => {
    const result = formatCheckSummary(
      [
        { name: "build", id: 1, conclusion: "success", errorCount: 0 },
        { name: "lint", id: 2, conclusion: "failure", errorCount: 1 },
      ],
      1
    );

    expect(result).toContain("1 passed");
    expect(result).toContain("1 workflow failed");
    expect(result).not.toContain("\u2705"); // No check emoji
    expect(result).not.toContain("\u274C"); // No X emoji
  });
});

describe("formatCheckRunOutput", () => {
  const createCheckRunOptions = (
    overrides: Partial<Parameters<typeof formatCheckRunOutput>[0]> = {}
  ) => ({
    owner: "test-owner",
    repo: "test-repo",
    headSha: "abc1234567890def1234567890def1234567890",
    runs: [],
    errors: [],
    totalErrors: 0,
    ...overrides,
  });

  describe("summary", () => {
    it("includes workflow stats in summary", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 3 },
            { name: "Test", id: 456, conclusion: "success", errorCount: 0 },
          ],
          totalErrors: 3,
        })
      );

      expect(result.summary).toContain("1 workflow failed");
      expect(result.summary).toContain("3 errors");
      expect(result.summary).toContain("1 passed");
    });

    it("includes failed workflows table", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 5 },
          ],
          totalErrors: 5,
        })
      );

      expect(result.summary).toContain("| Workflow | Status | Errors |");
      expect(result.summary).toContain("| Build | Failed | 5 |");
    });
  });

  describe("text (error details)", () => {
    it("includes errors grouped by file with source badges", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [
            {
              message: "Type error",
              filePath: "src/app.ts",
              line: 42,
              source: "typescript",
            },
            {
              message: "Cannot find module",
              filePath: "src/utils.ts",
              line: 10,
              source: "typescript",
            },
          ],
          totalErrors: 2,
        })
      );

      // Files should be linked and errors shown as bullet list with badges
      expect(result.text).toContain("[src/app.ts]");
      expect(result.text).toContain("- `42` [TS]");
      expect(result.text).toContain("Type error");
    });

    it("includes CLI command in text", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          headSha: "abc1234567890def1234567890def1234567890",
          errors: [{ message: "Error" }],
          totalErrors: 1,
        })
      );

      expect(result.text).toContain("`dt errors --commit abc1234`");
    });

    it("returns undefined text when no errors", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
          ],
          totalErrors: 0,
        })
      );

      expect(result.text).toBeUndefined();
    });

    it("should show source badges inline for different sources", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [
            {
              message: "Type error",
              source: "typescript",
              filePath: "a.ts",
              line: 1,
            },
            {
              message: "Lint error",
              source: "biome",
              filePath: "b.ts",
              line: 2,
            },
            {
              message: "Another type error",
              source: "typescript",
              filePath: "c.ts",
              line: 3,
            },
          ],
          totalErrors: 3,
        })
      );

      // Source badges should appear inline with each error
      expect(result.text).toContain("[TS]");
      expect(result.text).toContain("[Biome]");
      // Files should be listed separately
      expect(result.text).toContain("[a.ts]");
      expect(result.text).toContain("[b.ts]");
      expect(result.text).toContain("[c.ts]");
    });

    it("should group multiple errors under same file", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [
            {
              message: "Error 1",
              source: "typescript",
              filePath: "src/a.ts",
              line: 10,
            },
            {
              message: "Error 2",
              source: "typescript",
              filePath: "src/a.ts",
              line: 20,
            },
            {
              message: "Error 3",
              source: "typescript",
              filePath: "src/b.ts",
              line: 5,
            },
          ],
          totalErrors: 3,
        })
      );

      // Files should appear as clickable links
      expect(result.text).toContain("[src/a.ts]");
      expect(result.text).toContain("[src/b.ts]");
      // Errors as bullet list with line numbers
      expect(result.text).toContain("- `10`");
      expect(result.text).toContain("- `20`");
      expect(result.text).toContain("- `5`");
    });

    it("should use collapsible details only for overflow files (>10)", () => {
      // Create 12 files to trigger overflow
      const errors = Array.from({ length: 12 }, (_, i) => ({
        message: `Error ${i + 1}`,
        source: "typescript" as const,
        filePath: `src/file${i + 1}.ts`,
        line: i + 1,
      }));

      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors,
          totalErrors: 12,
        })
      );

      // Should have details tag for overflow
      expect(result.text).toContain("<details>");
      expect(result.text).toContain("View 2 more files");
      expect(result.text).toContain("</details>");
    });

    it("should not use details tags when 10 or fewer files", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [
            { message: "Error", source: "biome", filePath: "test.ts", line: 1 },
          ],
          totalErrors: 1,
        })
      );

      // No details tags for single file
      expect(result.text).not.toContain("<details>");
    });

    it("should show annotation note at top when errors have file and line", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [
            { message: "Error", source: "biome", filePath: "test.ts", line: 1 },
          ],
          totalErrors: 1,
        })
      );

      expect(result.text).toContain(
        "*1 error annotated inline where possible*"
      );
    });

    it("should handle errors without source", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [{ message: "Unknown error", filePath: "test.ts", line: 1 }],
          totalErrors: 1,
        })
      );

      // Error should appear without a source badge (no [TS] or similar)
      expect(result.text).toContain("- `1` Unknown error");
      // File link should still exist
      expect(result.text).toContain("[test.ts]");
    });

    it("should handle more than 10 errors in same file", () => {
      const errors = Array.from({ length: 25 }, (_, i) => ({
        message: `Error ${i + 1}`,
        source: "typescript" as const,
        filePath: "test.ts",
        line: i + 1,
      }));

      const result = formatCheckRunOutput(
        createCheckRunOptions({ errors, totalErrors: 25 })
      );

      // Should show all 25 errors as bullet points
      expect(result.text).toContain("- `25`");
      expect(result.text).toContain("Error 25");
    });
  });

  describe("annotations", () => {
    it("generates annotations for errors with file paths", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [
            {
              message: "Type 'string' is not assignable",
              filePath: "src/app.ts",
              line: 42,
              source: "typescript",
            },
          ],
          totalErrors: 1,
        })
      );

      expect(result.annotations).toHaveLength(1);
      expect(result.annotations?.[0]).toEqual({
        path: "src/app.ts",
        start_line: 42,
        end_line: 42,
        annotation_level: "failure",
        message: "Type 'string' is not assignable",
        title: "TypeScript",
      });
    });

    it("skips errors without file path or line", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [
            { message: "Error with path", filePath: "src/app.ts", line: 10 },
            { message: "Error without path" },
            { message: "Error with path no line", filePath: "src/other.ts" },
          ],
          totalErrors: 3,
        })
      );

      expect(result.annotations).toHaveLength(1);
      expect(result.annotations?.[0]?.path).toBe("src/app.ts");
    });

    it("limits annotations to 50", () => {
      const errors = Array.from({ length: 100 }, (_, i) => ({
        message: `Error ${i}`,
        filePath: `src/file${i}.ts`,
        line: i + 1,
      }));

      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors,
          totalErrors: 100,
        })
      );

      expect(result.annotations).toHaveLength(50);
    });

    it("returns undefined annotations when no errors have paths", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [{ message: "Error without path" }],
          totalErrors: 1,
        })
      );

      expect(result.annotations).toBeUndefined();
    });
  });
});

// Factory for creating passing comment options
const createPassingOptions = (
  overrides: Partial<Parameters<typeof formatPassingComment>[0]> = {}
) => ({
  runs: [],
  headSha: "abc1234567890def",
  ...overrides,
});

describe("formatPassingComment", () => {
  it("includes friendly Detent header for success", () => {
    const result = formatPassingComment(
      createPassingOptions({
        runs: [
          { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
        ],
      })
    );

    expect(result).toContain("All clear! Nothing to fix here");
    expect(result).toContain("Read the docs](https://detent.sh/docs)");
  });

  it("shows success message", () => {
    const result = formatPassingComment(
      createPassingOptions({
        runs: [
          { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
          { name: "Test", id: 456, conclusion: "success", errorCount: 0 },
        ],
      })
    );

    expect(result).toContain("✓ All checks passed");
  });

  it("includes commit message when provided", () => {
    const result = formatPassingComment(
      createPassingOptions({
        runs: [
          { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
        ],
        headCommitMessage: "fix: improve error handling",
      })
    );

    expect(result).toContain("`abc1234` fix: improve error handling");
  });

  it("shows passed count", () => {
    const result = formatPassingComment(
      createPassingOptions({
        runs: [
          { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
          { name: "Test", id: 456, conclusion: "success", errorCount: 0 },
        ],
      })
    );

    expect(result).toContain("2 passed");
  });

  it("shows skipped count when some workflows are skipped/cancelled", () => {
    const result = formatPassingComment(
      createPassingOptions({
        runs: [
          { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
          { name: "Deploy", id: 456, conclusion: "skipped", errorCount: 0 },
          { name: "Notify", id: 789, conclusion: "cancelled", errorCount: 0 },
        ],
      })
    );

    expect(result).toContain("1 passed");
    expect(result).toContain("2 skipped");
  });

  it("includes UTC timestamp", () => {
    const result = formatPassingComment(
      createPassingOptions({
        runs: [
          { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
        ],
      })
    );

    expect(result).toContain("Updated");
    expect(result).toContain("UTC");
    expect(result).toMatch(TIMESTAMP_PATTERN);
  });

  it("includes short SHA", () => {
    const result = formatPassingComment(
      createPassingOptions({
        headSha: "abc1234567890def",
        runs: [
          { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
        ],
      })
    );

    expect(result).toContain("`abc1234`");
  });

  it("uses middle dot separator between footer elements", () => {
    const result = formatPassingComment(
      createPassingOptions({
        runs: [
          { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
        ],
      })
    );

    expect(result).toContain(" · ");
  });

  it("handles empty runs array", () => {
    const result = formatPassingComment(createPassingOptions({ runs: [] }));

    expect(result).toContain("✓ All checks passed");
    expect(result).not.toContain("passed ·"); // No "0 passed" shown
  });
});

describe("XSS prevention", () => {
  const createCheckRunOptions = (
    overrides: Partial<Parameters<typeof formatCheckRunOutput>[0]> = {}
  ) => ({
    owner: "test-owner",
    repo: "test-repo",
    headSha: "abc1234567890def1234567890def1234567890",
    runs: [],
    errors: [],
    totalErrors: 0,
    ...overrides,
  });

  it("escapes HTML in file paths to prevent XSS", () => {
    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors: [
          {
            message: "Error",
            filePath: '<script>alert("xss")</script>',
            line: 1,
            source: "typescript",
          },
        ],
        totalErrors: 1,
      })
    );

    // File path should be HTML escaped in the text output
    expect(result.text).not.toContain("<script>");
    expect(result.text).toContain("&lt;script&gt;");
  });

  it("escapes HTML in workflow names to prevent XSS", () => {
    const result = formatResultsComment(
      createOptions({
        runs: [
          {
            name: "<img src=x onerror=alert(1)>",
            id: 123,
            conclusion: "failure",
            errorCount: 1,
          },
        ],
      })
    );

    // HTML should be escaped
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
  });

  it("escapes ampersands correctly without double-escaping", () => {
    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors: [
          {
            message: "Error",
            filePath: "foo&bar<baz",
            line: 1,
            source: "typescript",
          },
        ],
        totalErrors: 1,
      })
    );

    // & should become &amp; and < should become &lt;
    // But &amp; should NOT become &amp;amp;
    expect(result.text).toContain("&amp;");
    expect(result.text).toContain("&lt;");
    expect(result.text).not.toContain("&amp;amp;");
    expect(result.text).not.toContain("&amp;lt;");
  });

  it("escapes brackets in file paths to prevent markdown link injection", () => {
    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors: [
          {
            message: "Error",
            filePath: "src/test[1].ts",
            line: 1,
            source: "typescript",
          },
        ],
        totalErrors: 1,
      })
    );

    // Brackets should be escaped to prevent breaking markdown link syntax
    // "[src/test[1].ts](url)" would break; "[src/test\[1\].ts](url)" is correct
    expect(result.text).not.toContain("[src/test[1]");
    expect(result.text).toContain("\\[1\\]");
  });
});

describe("severity upgrade logic", () => {
  const createCheckRunOptions = (
    overrides: Partial<Parameters<typeof formatCheckRunOutput>[0]> = {}
  ) => ({
    owner: "test-owner",
    repo: "test-repo",
    headSha: "abc1234567890def1234567890def1234567890",
    runs: [],
    errors: [],
    totalErrors: 0,
    ...overrides,
  });

  it("keeps failure level when merging errors at same location (undefined severity defaults to failure)", () => {
    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors: [
          {
            message: "Info message",
            filePath: "src/app.ts",
            line: 10,
            // No severity -> defaults to failure (conservative for CI)
            source: "typescript" as const,
          },
          {
            message: "Warning message",
            filePath: "src/app.ts",
            line: 10,
            severity: "warning" as const,
            source: "typescript" as const,
          },
        ],
        totalErrors: 2,
      })
    );

    // Should have one annotation (deduplicated) - undefined maps to failure which is highest
    expect(result.annotations).toHaveLength(1);
    expect(result.annotations?.[0]?.annotation_level).toBe("failure");
  });

  it("upgrades warning to failure when merging errors at same location", () => {
    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors: [
          {
            message: "Warning message",
            filePath: "src/app.ts",
            line: 10,
            severity: "warning" as const,
            source: "typescript" as const,
          },
          {
            message: "Error message",
            filePath: "src/app.ts",
            line: 10,
            severity: "error" as const,
            source: "typescript" as const,
          },
        ],
        totalErrors: 2,
      })
    );

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations?.[0]?.annotation_level).toBe("failure");
  });

  it("keeps failure level when both errors map to failure", () => {
    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors: [
          {
            message: "Info message",
            filePath: "src/app.ts",
            line: 10,
            // No severity -> defaults to failure
            source: "typescript" as const,
          },
          {
            message: "Error message",
            filePath: "src/app.ts",
            line: 10,
            severity: "error" as const,
            source: "typescript" as const,
          },
        ],
        totalErrors: 2,
      })
    );

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations?.[0]?.annotation_level).toBe("failure");
  });

  it("does not downgrade severity when merging", () => {
    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors: [
          {
            message: "Error message",
            filePath: "src/app.ts",
            line: 10,
            severity: "error" as const,
            source: "typescript" as const,
          },
          {
            message: "Info message",
            filePath: "src/app.ts",
            line: 10,
            // No severity = notice level
            source: "typescript" as const,
          },
        ],
        totalErrors: 2,
      })
    );

    expect(result.annotations).toHaveLength(1);
    expect(result.annotations?.[0]?.annotation_level).toBe("failure");
  });
});

describe("GitHub API limits", () => {
  const createCheckRunOptions = (
    overrides: Partial<Parameters<typeof formatCheckRunOutput>[0]> = {}
  ) => ({
    owner: "test-owner",
    repo: "test-repo",
    headSha: "abc1234567890def1234567890def1234567890",
    runs: [],
    errors: [],
    totalErrors: 0,
    ...overrides,
  });

  it("truncates text output when exceeding 65000 chars", () => {
    // Create many errors with long messages to exceed the 65000 char limit
    // Message length is capped at 500 chars by truncateMessage, so we need many errors
    // Each error + markdown structure adds ~300-400 chars
    // 200 errors * ~350 chars = ~70000 chars
    const longMessage = "A".repeat(400);
    const sources = [
      "typescript",
      "eslint",
      "biome",
      "vitest",
      "rust",
      "go",
      "python",
    ] as const;
    const errors = Array.from({ length: 200 }, (_, i) => ({
      message: `${longMessage} error ${i + 1}`,
      filePath: `src/very/long/deeply/nested/directory/structure/path/file${i}.ts`,
      line: i + 1,
      source: sources[i % sources.length],
    }));

    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors,
        totalErrors: 200,
      })
    );

    // Text should be truncated and include truncation notice
    expect(result.text?.length).toBeLessThanOrEqual(65_000);
    expect(result.text).toContain("truncated");
  });

  it("caps displayed errors at 200 to limit output size", () => {
    const errors = Array.from({ length: 250 }, (_, i) => ({
      message: `Error ${i + 1}`,
      filePath: `src/file${i}.ts`,
      line: i + 1,
      source: "typescript" as const,
    }));

    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors,
        totalErrors: 250,
      })
    );

    // Should show truncation message
    expect(result.text).toContain("Showing 200 of 250 errors");
  });

  it("limits annotations to 50 per request", () => {
    const errors = Array.from({ length: 100 }, (_, i) => ({
      message: `Error ${i}`,
      filePath: `src/file${i}.ts`,
      line: i + 1,
      source: "typescript" as const,
    }));

    const result = formatCheckRunOutput(
      createCheckRunOptions({
        errors,
        totalErrors: 100,
      })
    );

    expect(result.annotations).toHaveLength(50);
  });
});

describe("formatWaitingComment", () => {
  it("includes friendly Detent header for waiting", () => {
    const result = formatWaitingComment({ headSha: "abc1234567890def" });

    expect(result).toContain("Detent is watching this PR");
    expect(result).toContain("Read the docs](https://detent.sh/docs)");
  });

  it("explains errors will be summarized", () => {
    const result = formatWaitingComment({ headSha: "abc1234567890def" });

    expect(result).toContain("any errors will be summarized here");
  });

  it("shows waiting on commit with short SHA", () => {
    const result = formatWaitingComment({ headSha: "abc1234567890def" });

    expect(result).toContain("Waiting on `abc1234`");
  });

  it("includes commit message when provided", () => {
    const result = formatWaitingComment({
      headSha: "abc1234567890def",
      headCommitMessage: "fix: improve error handling",
    });

    expect(result).toContain(
      "Waiting on `abc1234` fix: improve error handling"
    );
  });

  it("uses 7-character short SHA", () => {
    const result = formatWaitingComment({
      headSha: "1234567890abcdef1234567890abcdef12345678",
    });

    expect(result).toContain("`1234567`");
    expect(result).not.toContain("890abcdef");
  });
});
