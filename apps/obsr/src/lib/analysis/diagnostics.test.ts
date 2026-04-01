import type { CIError } from "@obsr/types";
import { describe, expect, it } from "vitest";
import {
  dedupeDiagnostics,
  mapExtractedDiagnostics,
  rankDiagnostics,
} from "./diagnostics";

const baseError: CIError = {
  message: "Type 'string' is not assignable to type 'number'",
  source: "typescript",
  severity: "error",
  category: "type-check",
  filePath: "src/app/page.tsx",
  line: 17,
  column: 9,
  ruleId: "TS2322",
  raw: "src/app/page.tsx:17:9 - error TS2322",
};

describe("diagnostic mapping", () => {
  it("maps extracted errors to the MVP diagnostic shape", () => {
    const diagnostics = mapExtractedDiagnostics([baseError], null);

    expect(diagnostics[0]).toMatchObject({
      message: baseError.message,
      source: "typescript",
      severity: "error",
      category: "type-check",
      filePath: "src/app/page.tsx",
      line: 17,
      column: 9,
      ruleId: "TS2322",
    });
    expect(diagnostics[0]?.fingerprint).toHaveLength(16);
    expect(diagnostics[0]?.evidence).toContain("TS2322");
  });

  it("scrubs secrets from code snippet evidence", () => {
    const diagnostics = mapExtractedDiagnostics(
      [
        {
          ...baseError,
          codeSnippet: {
            startLine: 1,
            errorLine: 1,
            language: "ts",
            lines: ["const token = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';"],
          },
        },
      ],
      null
    );

    expect(diagnostics[0]?.evidence).toContain("Code 1-1");
    expect(diagnostics[0]?.evidence).toContain("[");
    expect(diagnostics[0]?.evidence).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz1234567890"
    );
  });

  it("scrubs home paths before storing file locations", () => {
    const diagnostics = mapExtractedDiagnostics(
      [
        {
          ...baseError,
          filePath:
            "/Users/rodrigo/Documents/code/@handleui/obsr/apps/obsr/src/app/page.tsx",
        },
      ],
      null
    );

    expect(diagnostics[0]?.filePath).toBe(
      "/Users/[USER]/Documents/code/@handleui/obsr/apps/obsr/src/app/page.tsx"
    );
    expect(diagnostics[0]?.filePath).not.toContain("/Users/rodrigo");
  });

  it("dedupes diagnostics within a single analysis by fingerprint", () => {
    const diagnostics = mapExtractedDiagnostics([baseError, baseError], null);
    expect(dedupeDiagnostics(diagnostics)).toHaveLength(1);
  });

  it("ranks higher-severity and better-located diagnostics first", () => {
    const ranked = rankDiagnostics(
      dedupeDiagnostics(
        mapExtractedDiagnostics(
          [
            {
              ...baseError,
              message: "Unused variable",
              severity: "warning",
              category: "lint",
              ruleId: "no-unused-vars",
              source: "eslint",
            },
            baseError,
          ],
          null
        )
      )
    );

    expect(ranked[0]?.message).toBe(baseError.message);
    expect(ranked[0]?.rank).toBe(0);
    expect(ranked[1]?.rank).toBe(1);
  });
});
