import { describe, expect, it } from "vitest";
import { buildAnalysisPrompt } from "./prompt";

describe("buildAnalysisPrompt", () => {
  it("includes the summary and ranked diagnostics", () => {
    const prompt = buildAnalysisPrompt({
      summary: "TypeScript failed first in src/app/page.tsx.",
      diagnostics: [
        {
          fingerprint: "abc",
          message: "Type error",
          severity: "error",
          category: "type-check",
          source: "typescript",
          filePath: "src/app/page.tsx",
          line: 3,
          column: 2,
          ruleId: "TS2322",
          evidence: "Code 1-3",
          rank: 0,
        },
      ],
    });

    expect(prompt).toContain("CI summary:");
    expect(prompt).toContain("TypeScript failed first");
    expect(prompt).toContain("Fix first:");
    expect(prompt).toContain("TS2322");
  });

  it("keeps long prompts inside the copy limit", () => {
    const prompt = buildAnalysisPrompt({
      summary: "x".repeat(5000),
      diagnostics: Array.from({ length: 8 }, (_, index) => ({
        fingerprint: `${index}`,
        message: "y".repeat(300),
        severity: "error" as const,
        category: "compile" as const,
        source: "typescript" as const,
        filePath: "src/app/page.tsx",
        line: index + 1,
        column: 1,
        ruleId: `TS${index}`,
        evidence: "evidence",
        rank: index,
      })),
    });

    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(prompt).toContain("1. [typescript | TS0 | src/app/page.tsx:1:1]");
    expect(prompt).toContain("5. [typescript | TS4 | src/app/page.tsx:5:1]");
  });

  it("pre-truncates long diagnostic lines", () => {
    const prompt = buildAnalysisPrompt({
      summary: "TypeScript failed first.",
      diagnostics: [
        {
          fingerprint: "abc",
          message: "y".repeat(600),
          severity: "error",
          category: "compile",
          source: "typescript",
          filePath:
            "/Users/[USER]/Documents/code/@handleui/obsr/apps/obsr/src/app/page.tsx",
          line: 3,
          column: 2,
          ruleId: "TS2322",
          evidence: "Code 1-3",
          rank: 0,
        },
      ],
    });

    expect(prompt).toContain("TS2322");
    expect(prompt).toContain("/Users/[USER]/Documents");
    expect(prompt).toContain("...");
  });
});
