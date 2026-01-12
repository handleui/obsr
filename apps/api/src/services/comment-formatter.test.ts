import { describe, expect, it } from "vitest";
import { formatCheckSummary, formatResultsComment } from "./comment-formatter";

// Top-level regex for performance (matches "string | number" with optional backslash escape)
const PIPE_MESSAGE_PATTERN = /string\s*\\?\|\s*number/;

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
  describe("error message edge cases", () => {
    it("includes error messages with pipe characters", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [
            {
              message: "Type 'string | number' is not assignable to 'boolean'",
              filePath: "src/app.ts",
              line: 10,
              source: "typescript",
            },
          ],
          totalErrors: 1,
        })
      );

      // File is rendered as a link with backticks inside
      expect(result).toContain("[`src/app.ts`]");
      expect(result).toContain("| 10 |");
      // Message is included - the pipe may be escaped with backslash for markdown tables
      expect(result).toMatch(PIPE_MESSAGE_PATTERN);
    });

    it("handles messages with excessive whitespace and newlines", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [
            {
              message: "Error:\n  unexpected\n    token\n      found",
              filePath: "src/index.ts",
              line: 5,
            },
          ],
          totalErrors: 1,
        })
      );

      // Should not contain literal newlines in the table row
      const tableLines = result
        .split("\n")
        .filter((line) => line.includes("src/index.ts"));
      expect(tableLines[0]).not.toContain("\n  ");
      expect(tableLines[0]).toContain("Error:");
    });

    it("truncates very long error messages", () => {
      const longMessage = "A".repeat(200);
      const result = formatResultsComment(
        createOptions({
          errors: [{ message: longMessage, filePath: "src/app.ts", line: 1 }],
          totalErrors: 1,
        })
      );

      // Default truncation is 60 chars, should end with "..."
      expect(result).toContain("...");
      expect(result).not.toContain("A".repeat(100));
    });
  });

  describe("file path truncation", () => {
    it("truncates deeply nested file paths while preserving end segments", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [
            {
              message: "error",
              filePath:
                "packages/very-long-package-name/src/components/deeply/nested/Component.tsx",
              line: 42,
            },
          ],
          totalErrors: 1,
        })
      );

      // Should truncate path but preserve final segments for readability
      expect(result).toContain("...");
      expect(result).toContain("Component.tsx");
    });

    it("preserves short file paths without truncation", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [{ message: "error", filePath: "src/app.ts", line: 1 }],
          totalErrors: 1,
        })
      );

      expect(result).toContain("`src/app.ts`");
      expect(result).not.toContain("...");
    });

    it("handles errors without file path", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [{ message: "Unknown error occurred", source: "webpack" }],
          totalErrors: 1,
        })
      );

      expect(result).toContain("_unknown_");
      expect(result).toContain("Unknown error occurred");
    });
  });

  describe("empty and edge cases", () => {
    it("shows 'No errors found' when errors array is empty", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [],
          totalErrors: 0,
          runs: [
            { name: "build", id: 1, conclusion: "success", errorCount: 0 },
          ],
        })
      );

      expect(result).toContain("### No errors found");
      expect(result).not.toContain("| File |");
    });

    it("shows correct count when displaying top 10 of many errors", () => {
      const errors = Array.from({ length: 25 }, (_, i) => ({
        message: `Error ${i + 1}`,
        filePath: `src/file${i}.ts`,
        line: i + 1,
      }));

      const result = formatResultsComment(
        createOptions({
          errors,
          totalErrors: 25,
        })
      );

      expect(result).toContain("### Top Errors (10 of 25)");
      // Should only contain 10 error rows, not all 25
      const errorRows = result
        .split("\n")
        .filter((line) => line.includes("file") && line.includes(".ts"));
      expect(errorRows.length).toBe(10);
    });

    it("omits workflow table when runs array is empty", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [],
          errors: [{ message: "error", filePath: "src/app.ts", line: 1 }],
          totalErrors: 1,
        })
      );

      // Should not have the workflow table headers
      expect(result).not.toContain("| Workflow | Status | Errors |");
      // Should still have the errors table
      expect(result).toContain("| File | Line | Message | Source |");
    });
  });

  describe("URL encoding", () => {
    it("URL encodes file paths with spaces in GitHub blob links", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [
            {
              message: "error",
              filePath: "src/my file.ts",
              line: 1,
            },
          ],
          totalErrors: 1,
        })
      );

      // URL should have %20 for space
      expect(result).toContain("/blob/abc1234567890def/src/my%20file.ts");
      // Display text should still be readable (not encoded)
      expect(result).toContain("`src/my file.ts`");
    });

    it("URL encodes file paths with special characters", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [
            {
              message: "error",
              filePath: "src/components/[id]/page.tsx",
              line: 5,
            },
          ],
          totalErrors: 1,
        })
      );

      // Square brackets should be encoded
      expect(result).toContain("%5Bid%5D");
    });
  });

  describe("markdown escaping", () => {
    it("escapes pipe characters in error messages to preserve table structure", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [
            {
              message: "Type A | B | C is invalid",
              filePath: "src/app.ts",
              line: 1,
              source: "typescript",
            },
          ],
          totalErrors: 1,
        })
      );

      // Pipes should be escaped with backslash
      expect(result).toContain("\\|");
      // Table structure should remain intact (4 columns)
      const dataRows = result
        .split("\n")
        .filter((line) => line.startsWith("| ") && line.includes("src/app.ts"));
      for (const row of dataRows) {
        // Count unescaped pipes (table delimiters)
        const unescapedPipes = row
          .split("")
          .filter((c, i, arr) => c === "|" && arr[i - 1] !== "\\").length;
        expect(unescapedPipes).toBe(5); // 4 columns = 5 delimiters (|col1|col2|col3|col4|)
      }
    });

    it("escapes pipe characters in workflow names", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            {
              name: "Build | Test | Deploy",
              id: 123,
              conclusion: "success",
              errorCount: 0,
            },
          ],
        })
      );

      // Workflow name pipes should be escaped
      expect(result).toContain("Build \\| Test \\| Deploy");
    });

    it("escapes backticks in error messages", () => {
      const result = formatResultsComment(
        createOptions({
          errors: [
            {
              message: "Expected `string` but got `number`",
              filePath: "src/app.ts",
              line: 1,
            },
          ],
          totalErrors: 1,
        })
      );

      // Backticks should be escaped
      expect(result).toContain("\\`string\\`");
    });
  });

  describe("workflow run summary", () => {
    it("generates correct links to workflow runs", () => {
      const result = formatResultsComment(
        createOptions({
          owner: "my-org",
          repo: "my-repo",
          runs: [
            { name: "Build", id: 12_345, conclusion: "success", errorCount: 0 },
            { name: "Lint", id: 67_890, conclusion: "failure", errorCount: 3 },
          ],
        })
      );

      expect(result).toContain(
        "https://github.com/my-org/my-repo/actions/runs/12345"
      );
      expect(result).toContain(
        "https://github.com/my-org/my-repo/actions/runs/67890"
      );
      expect(result).toContain("Passed");
      expect(result).toContain("Failed");
    });
  });
});

describe("formatCheckSummary", () => {
  it("shows correct pluralization for single failure", () => {
    const result = formatCheckSummary(
      [{ name: "build", id: 1, conclusion: "failure", errorCount: 1 }],
      1
    );

    expect(result).toContain("**1** workflow failed");
    expect(result).toContain("**1** error found");
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

    expect(result).toContain("**2** workflows failed");
    expect(result).toContain("**5** errors found");
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
});
