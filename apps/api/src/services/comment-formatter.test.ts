import { describe, expect, it } from "vitest";
import {
  formatCheckRunOutput,
  formatCheckSummary,
  formatPassingComment,
  formatResultsComment,
} from "./comment-formatter";

// Top-level regex for performance (lint rule: useTopLevelRegex)
const TIMESTAMP_PATTERN = /Updated \w+ \d+, \d{2}:\d{2} UTC/;

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

  describe("minimal format", () => {
    it("shows only failed workflows in the table", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 3 },
            { name: "Test", id: 456, conclusion: "success", errorCount: 0 },
            { name: "Lint", id: 789, conclusion: "failure", errorCount: 2 },
          ],
        })
      );

      // Failed workflows should be in table
      expect(result).toContain("| [Build]");
      expect(result).toContain("| [Lint]");
      expect(result).toContain("| Failed |");

      // Passed workflows should NOT be in table (only in footer count)
      expect(result).not.toContain("| [Test]");
    });

    it("includes workflow links to GitHub Actions", () => {
      const result = formatResultsComment(
        createOptions({
          owner: "my-org",
          repo: "my-repo",
          runs: [
            { name: "Build", id: 12_345, conclusion: "failure", errorCount: 3 },
          ],
        })
      );

      expect(result).toContain(
        "https://github.com/my-org/my-repo/actions/runs/12345"
      );
    });

    it("shows error count per workflow", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 5 },
          ],
        })
      );

      expect(result).toContain("| 5 |");
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

      expect(result).toContain("Updated");
      expect(result).toContain("UTC");
      // Should use 24h format (e.g., "Jan 12, 15:30")
      expect(result).toMatch(TIMESTAMP_PATTERN);
    });

    it("includes CLI command with short SHA", () => {
      const result = formatResultsComment(
        createOptions({
          headSha: "abc1234567890def",
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 1 },
          ],
        })
      );

      expect(result).toContain("`detent errors --commit abc1234`");
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
  });

  describe("table structure", () => {
    it("has correct table headers", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "failure", errorCount: 3 },
          ],
        })
      );

      expect(result).toContain("| Workflow | Status | Errors |");
      expect(result).toContain("|----------|--------|--------|");
    });
  });

  describe("markdown escaping", () => {
    it("escapes pipe characters in workflow names", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            {
              name: "Build | Test | Deploy",
              id: 123,
              conclusion: "failure",
              errorCount: 1,
            },
          ],
        })
      );

      // Workflow name pipes should be escaped
      expect(result).toContain("Build \\| Test \\| Deploy");
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
    it("includes top errors table when errors exist", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          errors: [
            { message: "Type error", filePath: "src/app.ts", line: 42 },
            {
              message: "Cannot find module",
              filePath: "src/utils.ts",
              line: 10,
            },
          ],
          totalErrors: 2,
        })
      );

      expect(result.text).toContain("### Top Errors");
      expect(result.text).toContain("| File | Line | Message |");
      expect(result.text).toContain("src/app.ts");
      expect(result.text).toContain("42");
    });

    it("includes CLI command in text", () => {
      const result = formatCheckRunOutput(
        createCheckRunOptions({
          headSha: "abc1234567890def1234567890def1234567890",
          errors: [{ message: "Error" }],
          totalErrors: 1,
        })
      );

      expect(result.text).toContain("`detent errors --commit abc1234`");
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
