import { describe, expect, it } from "vitest";
import { formatCheckSummary, formatResultsComment } from "./comment-formatter";

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

    it("includes UTC timestamp", () => {
      const result = formatResultsComment(createOptions());

      expect(result).toContain("Updated");
      expect(result).toContain("UTC");
    });

    it("includes CLI command with short SHA", () => {
      const result = formatResultsComment(
        createOptions({
          headSha: "abc1234567890def",
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

    it("renders empty table when no workflows fail", () => {
      const result = formatResultsComment(
        createOptions({
          runs: [
            { name: "Build", id: 123, conclusion: "success", errorCount: 0 },
          ],
        })
      );

      // Should still have headers
      expect(result).toContain("| Workflow | Status | Errors |");
      // But no data rows (only headers, separator, empty line, footer)
      const lines = result.split("\n");
      const dataRows = lines.filter(
        (line) => line.startsWith("| [") // Data rows start with "| [Name]"
      );
      expect(dataRows.length).toBe(0);
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

  it("uses plain text status without emojis", () => {
    const result = formatCheckSummary(
      [
        { name: "build", id: 1, conclusion: "success", errorCount: 0 },
        { name: "lint", id: 2, conclusion: "failure", errorCount: 1 },
      ],
      1
    );

    expect(result).toContain("Passed");
    expect(result).toContain("Failed");
    expect(result).not.toContain("\u2705"); // No check emoji
    expect(result).not.toContain("\u274C"); // No X emoji
  });
});
