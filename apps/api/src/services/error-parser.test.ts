import { describe, expect, it } from "vitest";
import {
  parseWorkflowLogs,
  parseWorkflowLogsWithFallback,
} from "./error-parser";

describe("parseWorkflowLogs", () => {
  describe("successful parsing", () => {
    it("extracts TypeScript errors from logs", () => {
      const logs = `
2024-01-15T10:00:00.000Z src/app.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
2024-01-15T10:00:01.000Z Build completed with errors.
`.trim();

      const result = parseWorkflowLogs(logs, { totalBytes: 150, jobCount: 1 });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatchObject({
        filePath: "src/app.ts",
        line: 10,
        column: 5,
        ruleId: "TS2322",
        message: expect.stringContaining("assignable"),
      });
    });

    it("extracts Go errors from logs", () => {
      const logs = `
2024-01-15T10:00:00.000Z main.go:15:3: undefined: foo
`.trim();

      const result = parseWorkflowLogs(logs, { totalBytes: 50, jobCount: 1 });

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatchObject({
        filePath: "main.go",
        line: 15,
      });
    });

    it("returns metadata with the result", () => {
      const logs = "Some logs without errors";

      const result = parseWorkflowLogs(logs, { totalBytes: 25, jobCount: 2 });

      expect(result.metadata).toEqual({
        logBytes: 25,
        jobCount: 2,
        parsersAvailable: expect.arrayContaining([
          "TypeScript",
          "Go",
          "Python",
          "ESLint",
        ]),
      });
    });
  });

  describe("empty results", () => {
    it("returns empty array when no errors found", () => {
      const logs = `
2024-01-15T10:00:00.000Z Starting build...
2024-01-15T10:00:01.000Z Build successful!
`.trim();

      const result = parseWorkflowLogs(logs, { totalBytes: 100, jobCount: 1 });

      expect(result.errors).toEqual([]);
    });

    it("handles empty logs string", () => {
      const result = parseWorkflowLogs("", { totalBytes: 0, jobCount: 0 });

      expect(result.errors).toEqual([]);
    });
  });
});

describe("parseWorkflowLogsWithFallback", () => {
  it("adds fallback error when no errors found", () => {
    const logs = `
2024-01-15T10:00:00.000Z Starting build...
2024-01-15T10:00:01.000Z Process exited with code 1
`.trim();

    const result = parseWorkflowLogsWithFallback(logs, "Build", {
      totalBytes: 100,
      jobCount: 1,
    });

    expect(result.errors.length).toBe(1);
    const error = result.errors[0];
    expect(error).toBeDefined();
    expect(error?.message).toContain("Build");
    expect(error?.message).toContain("no parseable errors");
    expect(error?.message).toContain("100 bytes");
    expect(error?.message).toContain("1 job");
    expect(error?.workflowJob).toBe("Build");
    expect(error?.category).toBe("workflow");
    expect(error?.severity).toBe("error");
  });

  it("does not add fallback when errors are found", () => {
    const logs = `
2024-01-15T10:00:00.000Z src/app.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
`.trim();

    const result = parseWorkflowLogsWithFallback(logs, "Build", {
      totalBytes: 100,
      jobCount: 1,
    });

    // Should not contain fallback message
    const hasFallback = result.errors.some((e) =>
      e.message.includes("no parseable errors")
    );
    expect(hasFallback).toBe(false);
  });

  it("formats bytes correctly in fallback message", () => {
    const logs = "No errors here";

    // Test KB formatting
    const resultKB = parseWorkflowLogsWithFallback(logs, "Test", {
      totalBytes: 2048,
      jobCount: 1,
    });
    expect(resultKB.errors[0]?.message).toContain("2.0 KB");

    // Test MB formatting
    const resultMB = parseWorkflowLogsWithFallback(logs, "Test", {
      totalBytes: 1_500_000,
      jobCount: 1,
    });
    expect(resultMB.errors[0]?.message).toContain("1.4 MB");
  });

  it("includes plural jobs in fallback message", () => {
    const logs = "No errors here";

    const result = parseWorkflowLogsWithFallback(logs, "Test", {
      totalBytes: 100,
      jobCount: 3,
    });

    expect(result.errors[0]?.message).toContain("3 jobs");
  });
});

describe("error field mapping", () => {
  it("maps ExtractedError fields to ParsedError format", () => {
    const logs = `
2024-01-15T10:00:00.000Z src/app.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
`.trim();

    const result = parseWorkflowLogs(logs, { totalBytes: 100, jobCount: 1 });

    expect(result.errors.length).toBeGreaterThan(0);
    const error = result.errors[0];
    expect(error).toBeDefined();

    // Check that fields are mapped correctly
    expect(error).toHaveProperty("filePath");
    expect(error).toHaveProperty("line");
    expect(error).toHaveProperty("column");
    expect(error).toHaveProperty("message");
    // Optional fields should exist or be undefined (not throw)
    if (error) {
      expect("category" in error || error.category === undefined).toBe(true);
      expect("severity" in error || error.severity === undefined).toBe(true);
      expect("source" in error || error.source === undefined).toBe(true);
    }
  });
});
