import { describe, expect, it } from "vitest";
import {
  createIssueDiagnosticDraft,
  dedupeIssueDiagnostics,
  rankIssueDiagnostics,
} from "./normalize.js";

describe("issue diagnostics", () => {
  it("creates stable fingerprints from small generic inputs", () => {
    const first = createIssueDiagnosticDraft({
      message: "Cannot find name 'describe'.",
      source: "typescript",
      ruleId: "TS2593",
      filePath: "src/example.test.ts",
      line: 7,
      column: 1,
    });

    const second = createIssueDiagnosticDraft({
      message: "Cannot find name 'describe'.",
      source: "typescript",
      ruleId: "TS2593",
      filePath: "src/example.test.ts",
      line: 7,
      column: 1,
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.repoFingerprint).toBe(second.repoFingerprint);
    expect(first.loreFingerprint).toBe(second.loreFingerprint);
  });

  it("dedupes diagnostics by fingerprint", () => {
    const diagnostic = createIssueDiagnosticDraft({
      message: "Duplicate failure",
      source: "typescript",
    });

    expect(dedupeIssueDiagnostics([diagnostic, diagnostic])).toHaveLength(1);
  });

  it("ranks errors ahead of warnings and located items ahead of vague ones", () => {
    const warning = createIssueDiagnosticDraft({
      message: "Unused variable",
      severity: "warning",
      category: "lint",
      source: "biome",
    });
    const error = createIssueDiagnosticDraft({
      message: "Type mismatch",
      severity: "error",
      category: "type-check",
      source: "typescript",
      filePath: "src/app.ts",
      line: 10,
    });

    expect(rankIssueDiagnostics([warning, error])[0]?.message).toBe(
      "Type mismatch"
    );
  });
});
