import { describe, expect, test } from "vitest";
import type { HintableError, HintRule } from "../types.js";
import { createHintMatcher, getHintsForError, matchHints } from "./matcher.js";

const GO_UNDEFINED_PATTERN = /undefined:/;

describe("matchHints", () => {
  describe("ruleId matching", () => {
    test("matches TypeScript error by ruleId", () => {
      const errors: HintableError[] = [
        {
          message: "Type 'string' is not assignable",
          source: "typescript",
          ruleId: "TS2322",
        },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints.length).toBeGreaterThan(0);
      expect(result[0].hints[0]).toContain("Type mismatch");
    });

    test("matches Biome lint rule by ruleId", () => {
      const errors: HintableError[] = [
        {
          message: "Use const instead of var",
          source: "biome",
          ruleId: "lint/style/noVar",
        },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints[0]).toContain("const");
    });

    test("matches ESLint rule by ruleId", () => {
      const errors: HintableError[] = [
        {
          message: "'x' is defined but never used",
          source: "eslint",
          ruleId: "no-unused-vars",
        },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints[0]).toContain("unused");
    });
  });

  describe("messagePattern matching", () => {
    test("matches Go undefined error by pattern", () => {
      const errors: HintableError[] = [
        { message: "undefined: someFunc", source: "go" },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints[0]).toContain("Undefined identifier");
    });

    test("matches Go unused variable by pattern", () => {
      const errors: HintableError[] = [
        { message: "x declared but not used", source: "go" },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints[0]).toContain("Unused variable");
    });

    test("matches Python NameError by pattern", () => {
      const errors: HintableError[] = [
        { message: "NameError: name 'foo' is not defined", source: "python" },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints[0]).toContain("Undefined name");
    });

    test("matches Rust unused variable by pattern", () => {
      const errors: HintableError[] = [
        { message: "unused variable: `x`", source: "rust" },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints[0]).toContain("underscore");
    });

    test("matches Vitest assertion failure by pattern", () => {
      const errors: HintableError[] = [
        { message: "expected 'foo' to equal 'bar'", source: "vitest" },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints[0]).toContain("Assertion failed");
    });
  });

  describe("no match cases", () => {
    test("returns empty hints for unmatched error", () => {
      const errors: HintableError[] = [
        { message: "some random error", source: "typescript" },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints).toHaveLength(0);
    });

    test("returns empty hints when source doesn't match rules", () => {
      const errors: HintableError[] = [
        { message: "undefined: foo", source: "typescript" },
      ];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints).toHaveLength(0);
    });

    test("returns empty hints when source is missing", () => {
      const errors: HintableError[] = [{ message: "undefined: foo" }];
      const result = matchHints(errors);
      expect(result).toHaveLength(1);
      expect(result[0].hints).toHaveLength(0);
    });
  });

  describe("preserves error reference", () => {
    test("result contains original error object", () => {
      const error: HintableError = { message: "test", source: "go" };
      const result = matchHints([error]);
      expect(result[0].error).toBe(error);
    });
  });

  describe("hint formatting", () => {
    test("includes docUrl when present", () => {
      const errors: HintableError[] = [
        { message: "type mismatch", source: "typescript", ruleId: "TS2322" },
      ];
      const result = matchHints(errors);
      expect(result[0].hints[0]).toContain("Docs:");
    });

    test("includes fixPattern when present", () => {
      const errors: HintableError[] = [
        { message: "use const", source: "biome", ruleId: "lint/style/noVar" },
      ];
      const result = matchHints(errors);
      expect(result[0].hints[0]).toContain("Fix:");
    });
  });

  describe("empty input", () => {
    test("returns empty array for empty input", () => {
      const result = matchHints([]);
      expect(result).toEqual([]);
    });
  });
});

describe("getHintsForError", () => {
  test("returns hints array for matched error", () => {
    const error: HintableError = {
      message: "type mismatch",
      source: "typescript",
      ruleId: "TS2322",
    };
    const hints = getHintsForError(error);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toContain("Type mismatch");
  });

  test("returns empty array for unmatched error", () => {
    const error: HintableError = {
      message: "random error",
      source: "typescript",
    };
    const hints = getHintsForError(error);
    expect(hints).toEqual([]);
  });
});

describe("createHintMatcher", () => {
  test("custom rules are checked before built-in rules", () => {
    const customRules: HintRule[] = [
      { source: "typescript", ruleId: "TS2322", hint: "CUSTOM HINT" },
    ];
    const matcher = createHintMatcher(customRules);
    const error: HintableError = {
      message: "type mismatch",
      source: "typescript",
      ruleId: "TS2322",
    };
    const hints = matcher.getHintsForError(error);
    expect(hints[0]).toBe("CUSTOM HINT");
    expect(hints.length).toBeGreaterThan(1);
  });

  test("both custom and built-in hints are returned", () => {
    const customRules: HintRule[] = [
      {
        source: "go",
        messagePattern: GO_UNDEFINED_PATTERN,
        hint: "CUSTOM GO HINT",
      },
    ];
    const matcher = createHintMatcher(customRules);
    const error: HintableError = { message: "undefined: foo", source: "go" };
    const hints = matcher.getHintsForError(error);
    expect(hints).toContain("CUSTOM GO HINT");
    expect(hints.some((h) => h.includes("Undefined identifier"))).toBe(true);
  });

  test("matchHints works with custom matcher", () => {
    const customRules: HintRule[] = [
      { source: "python", ruleId: "E999", hint: "Syntax error detected" },
    ];
    const matcher = createHintMatcher(customRules);
    const errors: HintableError[] = [
      { message: "syntax error", source: "python", ruleId: "E999" },
    ];
    const result = matcher.matchHints(errors);
    expect(result[0].hints[0]).toBe("Syntax error detected");
  });
});

describe("ReDoS protection", () => {
  test("skips regex matching for messages exceeding 2000 chars", () => {
    const longMessage = "a".repeat(2001);
    const error: HintableError = { message: longMessage, source: "go" };
    const result = matchHints([error]);
    expect(result[0].hints).toHaveLength(0);
  });

  test("allows regex matching for messages under 2000 chars", () => {
    const message = `${"a".repeat(1985)}undefined: x`;
    const error: HintableError = { message, source: "go" };
    const result = matchHints([error]);
    expect(result[0].hints.length).toBeGreaterThan(0);
  });
});

describe("source-indexed lookup", () => {
  test("only matches rules for the correct source", () => {
    const goError: HintableError = { message: "undefined: foo", source: "go" };
    const tsError: HintableError = {
      message: "undefined: foo",
      source: "typescript",
    };

    const goResult = matchHints([goError]);
    const tsResult = matchHints([tsError]);

    expect(goResult[0].hints.length).toBeGreaterThan(0);
    expect(tsResult[0].hints).toHaveLength(0);
  });
});
