import { describe, expect, it } from "vitest";
import { buildFallbackSummary, summarizeDiagnostics } from "./summary";

const diagnostics = [
  {
    fingerprint: "abc",
    message: "Type error",
    severity: "error" as const,
    category: "type-check" as const,
    source: "typescript" as const,
    filePath: "src/app/page.tsx",
    line: 8,
    column: 4,
    ruleId: "TS2322",
    evidence: "Code 8-10",
    rank: 0,
  },
];

describe("summarizeDiagnostics", () => {
  it("returns the generated summary when AI succeeds", async () => {
    const summary = await summarizeDiagnostics(diagnostics, {
      generateSummary: async () =>
        "TypeScript failed first in src/app/page.tsx.",
    });

    expect(summary).toBe("TypeScript failed first in src/app/page.tsx.");
  });

  it("falls back to a deterministic summary when AI fails", async () => {
    const summary = await summarizeDiagnostics(diagnostics, {
      generateSummary: () => Promise.reject(new Error("boom")),
    });

    expect(summary).toBe(buildFallbackSummary(diagnostics));
  });
});
