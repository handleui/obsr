import { describe, expect, test } from "vitest";
import {
  type CIError,
  countByCategory,
  countErrors,
  type ErrorCategory,
  formatError,
  formatErrors,
  formatStackTrace,
  getCategoryPriority,
  prioritizeErrors,
} from "./format.js";

const EXTRA_BLANK_LINES_PATTERN = /\n\s*\n\s*\n/;
const STACK_TRACE_FORMAT_PATTERN =
  /^ {2}Stack trace:\n {4}at file\.go:10\n {4}at main\.go:20$/;
const COMPILE_THEN_LINT_PATTERN = /^\[compile\].*\n\n\[lint\]/;

describe("getCategoryPriority", () => {
  test("returns correct priority for each category", () => {
    expect(getCategoryPriority("compile")).toBe(1);
    expect(getCategoryPriority("type-check")).toBe(2);
    expect(getCategoryPriority("test")).toBe(3);
    expect(getCategoryPriority("runtime")).toBe(4);
    expect(getCategoryPriority("lint")).toBe(5);
    expect(getCategoryPriority("infrastructure")).toBe(6);
    expect(getCategoryPriority("metadata")).toBe(7);
    expect(getCategoryPriority("security")).toBe(8);
    expect(getCategoryPriority("dependency")).toBe(9);
    expect(getCategoryPriority("config")).toBe(10);
    expect(getCategoryPriority("docs")).toBe(11);
    expect(getCategoryPriority("unknown")).toBe(12);
  });

  test("compile has highest priority (lowest number)", () => {
    const categories: ErrorCategory[] = [
      "compile",
      "type-check",
      "test",
      "runtime",
      "lint",
      "infrastructure",
      "metadata",
      "security",
      "dependency",
      "config",
      "docs",
      "unknown",
    ];

    for (const category of categories) {
      expect(getCategoryPriority("compile")).toBeLessThanOrEqual(
        getCategoryPriority(category)
      );
    }
  });

  test("unknown has lowest priority (highest number)", () => {
    const categories: ErrorCategory[] = [
      "compile",
      "type-check",
      "test",
      "runtime",
      "lint",
      "infrastructure",
      "metadata",
      "security",
      "dependency",
      "config",
      "docs",
      "unknown",
    ];

    for (const category of categories) {
      expect(getCategoryPriority("unknown")).toBeGreaterThanOrEqual(
        getCategoryPriority(category)
      );
    }
  });
});

describe("formatStackTrace", () => {
  describe("category filtering", () => {
    test("includes trace for compile category", () => {
      const error: CIError = {
        message: "error",
        category: "compile",
        stackTrace: "at main.go:10\nat app.go:20",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("Stack trace:");
      expect(result).toContain("main.go:10");
    });

    test("includes trace for test category", () => {
      const error: CIError = {
        message: "error",
        category: "test",
        stackTrace: "at test.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("Stack trace:");
    });

    test("includes trace for runtime category", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at runtime_error.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("Stack trace:");
    });

    test("includes trace for unknown category", () => {
      const error: CIError = {
        message: "error",
        category: "unknown",
        stackTrace: "at unknown.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("Stack trace:");
    });

    test("excludes trace for lint category", () => {
      const error: CIError = {
        message: "error",
        category: "lint",
        stackTrace: "at linter.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("excludes trace for type-check category", () => {
      const error: CIError = {
        message: "error",
        category: "type-check",
        stackTrace: "at checker.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("excludes trace for infrastructure category", () => {
      const error: CIError = {
        message: "error",
        category: "infrastructure",
        stackTrace: "at infra.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("excludes trace for metadata category", () => {
      const error: CIError = {
        message: "error",
        category: "metadata",
        stackTrace: "at meta.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("excludes trace for security category", () => {
      const error: CIError = {
        message: "error",
        category: "security",
        stackTrace: "at security.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("excludes trace for dependency category", () => {
      const error: CIError = {
        message: "error",
        category: "dependency",
        stackTrace: "at dep.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("excludes trace for config category", () => {
      const error: CIError = {
        message: "error",
        category: "config",
        stackTrace: "at config.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("excludes trace for docs category", () => {
      const error: CIError = {
        message: "error",
        category: "docs",
        stackTrace: "at docs.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("defaults to unknown category when not specified", () => {
      const error: CIError = {
        message: "error",
        stackTrace: "at file.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("Stack trace:");
    });
  });

  describe("frame filtering", () => {
    test("filters out node_modules/ frames", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace:
          "at app.js:10\nat node_modules/lodash/index.js:50\nat main.js:20",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.js:10");
      expect(result).toContain("main.js:20");
      expect(result).not.toContain("node_modules");
    });

    test("filters out runtime/ frames", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at app.go:10\nat runtime/proc.go:50\nat main.go:20",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.go:10");
      expect(result).not.toContain("runtime/proc.go");
    });

    test("filters out vendor/ frames", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at app.go:10\nat vendor/pkg/util.go:50",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.go:10");
      expect(result).not.toContain("vendor/");
    });

    test("filters out site-packages/ frames", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at app.py:10\nat site-packages/requests/api.py:50",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.py:10");
      expect(result).not.toContain("site-packages");
    });

    test("filters out <anonymous> frames", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at app.js:10\nat <anonymous>:1:1",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.js:10");
      expect(result).not.toContain("<anonymous>");
    });

    test("filters out (internal/ frames", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at app.js:10\nat (internal/modules/cjs/loader.js:1)",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.js:10");
      expect(result).not.toContain("(internal/");
    });

    test("filters out testing/testing.go frames", () => {
      const error: CIError = {
        message: "error",
        category: "test",
        stackTrace: "at test.go:10\nat testing/testing.go:1234",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("test.go:10");
      expect(result).not.toContain("testing/testing.go");
    });

    test("filters out syscall/ frames", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at app.go:10\nat syscall/syscall_unix.go:50",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.go:10");
      expect(result).not.toContain("syscall/");
    });

    test("filters out reflect/ frames", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at app.go:10\nat reflect/value.go:50",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.go:10");
      expect(result).not.toContain("reflect/");
    });

    test("filters out .npm/ frames", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at app.js:10\nat .npm/_npx/cache/index.js:50",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.js:10");
      expect(result).not.toContain(".npm/");
    });

    test("filters out empty lines", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at app.go:10\n\n\nat main.go:20",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("app.go:10");
      expect(result).toContain("main.go:20");
      // Should not have extra blank lines in output
      expect(result).not.toMatch(EXTRA_BLANK_LINES_PATTERN);
    });

    test("returns empty when all frames are filtered", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace:
          "at node_modules/lodash/index.js:50\nat runtime/proc.go:100",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });
  });

  describe("truncation", () => {
    test("truncates to 20 lines max", () => {
      const lines = Array.from({ length: 30 }, (_, i) => `at file${i}.go:${i}`);
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: lines.join("\n"),
      };
      const result = formatStackTrace(error);

      expect(result).toContain("file0.go:0");
      expect(result).toContain("file19.go:19");
      expect(result).not.toContain("file20.go:20");
      expect(result).toContain("... (truncated, 10 more frames)");
    });

    test("shows remaining frame count after truncation", () => {
      const lines = Array.from({ length: 25 }, (_, i) => `at file${i}.go:${i}`);
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: lines.join("\n"),
      };
      const result = formatStackTrace(error);
      expect(result).toContain("... (truncated, 5 more frames)");
    });

    test("does not truncate when under 20 lines", () => {
      const lines = Array.from({ length: 10 }, (_, i) => `at file${i}.go:${i}`);
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: lines.join("\n"),
      };
      const result = formatStackTrace(error);
      expect(result).not.toContain("truncated");
      expect(result).toContain("file9.go:9");
    });

    test("shows truncation message for stack trace exceeding 50KB", () => {
      const longLine = "a".repeat(60 * 1024);
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: longLine,
      };
      const result = formatStackTrace(error);
      expect(result).toBe("  Stack trace: (truncated - exceeds 50KB limit)");
    });

    test("does not show 50KB truncation for stack under limit", () => {
      const shortTrace = "at file.go:10";
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: shortTrace,
      };
      const result = formatStackTrace(error);
      expect(result).not.toContain("exceeds 50KB limit");
    });
  });

  describe("escaping", () => {
    test("escapes backticks to single quotes", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at `file`.go:10",
      };
      const result = formatStackTrace(error);
      expect(result).toContain("'file'.go:10");
      expect(result).not.toContain("`");
    });
  });

  describe("edge cases", () => {
    test("returns empty string when no stackTrace", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("returns empty string for empty stackTrace", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("returns empty string for whitespace-only stackTrace", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "   \n   \n   ",
      };
      const result = formatStackTrace(error);
      expect(result).toBe("");
    });

    test("formats stack trace with proper indentation", () => {
      const error: CIError = {
        message: "error",
        category: "runtime",
        stackTrace: "at file.go:10\nat main.go:20",
      };
      const result = formatStackTrace(error);
      expect(result).toMatch(STACK_TRACE_FORMAT_PATTERN);
    });
  });
});

describe("formatError", () => {
  describe("location formatting", () => {
    test("formats file:line:col when all present", () => {
      const error: CIError = {
        message: "undefined variable",
        filePath: "src/app.go",
        line: 10,
        column: 5,
        category: "compile",
      };
      const result = formatError(error);
      expect(result).toBe("[compile] src/app.go:10:5: undefined variable");
    });

    test("defaults column to 1 when line is present but column is not", () => {
      const error: CIError = {
        message: "undefined variable",
        filePath: "src/app.go",
        line: 10,
        category: "compile",
      };
      const result = formatError(error);
      expect(result).toBe("[compile] src/app.go:10:1: undefined variable");
    });

    test("shows dashes for missing line and column", () => {
      const error: CIError = {
        message: "error",
        filePath: "src/app.go",
        category: "compile",
      };
      const result = formatError(error);
      expect(result).toBe("[compile] src/app.go:-:-: error");
    });

    test("shows line format when no file path", () => {
      const error: CIError = {
        message: "error",
        line: 10,
        column: 5,
        category: "compile",
      };
      const result = formatError(error);
      expect(result).toBe("[compile] line 10:5: error");
    });

    test("shows dashes when no file and no line", () => {
      const error: CIError = {
        message: "error",
        category: "compile",
      };
      const result = formatError(error);
      expect(result).toBe("[compile] line -:-: error");
    });

    test("handles line 0 as missing", () => {
      const error: CIError = {
        message: "error",
        filePath: "src/app.go",
        line: 0,
        category: "compile",
      };
      const result = formatError(error);
      expect(result).toBe("[compile] src/app.go:-:-: error");
    });
  });

  describe("category handling", () => {
    test("defaults to unknown category when not specified", () => {
      const error: CIError = {
        message: "error",
        filePath: "file.go",
        line: 1,
      };
      const result = formatError(error);
      expect(result).toContain("[unknown]");
    });

    test("uses provided category", () => {
      const error: CIError = {
        message: "error",
        filePath: "file.go",
        line: 1,
        category: "lint",
      };
      const result = formatError(error);
      expect(result).toContain("[lint]");
    });
  });

  describe("rule and source line", () => {
    test("includes rule and source when both present", () => {
      const error: CIError = {
        message: "error",
        filePath: "file.go",
        line: 1,
        category: "lint",
        ruleId: "no-unused-vars",
        source: "const x = 1;",
      };
      const result = formatError(error);
      expect(result).toContain("[lint] file.go:1:1: error");
      expect(result).toContain("Rule: no-unused-vars | Source: const x = 1;");
    });

    test("includes rule with dash for missing source", () => {
      const error: CIError = {
        message: "error",
        filePath: "file.go",
        line: 1,
        category: "lint",
        ruleId: "no-unused-vars",
      };
      const result = formatError(error);
      expect(result).toContain("Rule: no-unused-vars | Source: -");
    });

    test("includes source with dash for missing rule", () => {
      const error: CIError = {
        message: "error",
        filePath: "file.go",
        line: 1,
        category: "lint",
        source: "const x = 1;",
      };
      const result = formatError(error);
      expect(result).toContain("Rule: - | Source: const x = 1;");
    });

    test("does not include rule/source line when neither present", () => {
      const error: CIError = {
        message: "error",
        filePath: "file.go",
        line: 1,
        category: "lint",
      };
      const result = formatError(error);
      expect(result).not.toContain("Rule:");
      expect(result).not.toContain("Source:");
    });
  });

  describe("stack trace integration", () => {
    test("includes stack trace for eligible categories", () => {
      const error: CIError = {
        message: "panic",
        filePath: "file.go",
        line: 1,
        category: "runtime",
        stackTrace: "at handler.go:50",
      };
      const result = formatError(error);
      expect(result).toContain("[runtime] file.go:1:1: panic");
      expect(result).toContain("Stack trace:");
      expect(result).toContain("handler.go:50");
    });

    test("excludes stack trace for non-eligible categories", () => {
      const error: CIError = {
        message: "error",
        filePath: "file.go",
        line: 1,
        category: "lint",
        stackTrace: "at linter.go:50",
      };
      const result = formatError(error);
      expect(result).not.toContain("Stack trace:");
    });
  });

  describe("escaping", () => {
    test("escapes backticks in file path", () => {
      const error: CIError = {
        message: "error",
        filePath: "`special`/file.go",
        line: 1,
        category: "compile",
      };
      const result = formatError(error);
      expect(result).toContain("'special'/file.go");
    });

    test("escapes backticks in message", () => {
      const error: CIError = {
        message: "undefined `variable`",
        filePath: "file.go",
        line: 1,
        category: "compile",
      };
      const result = formatError(error);
      expect(result).toContain("undefined 'variable'");
    });

    test("escapes backticks in ruleId", () => {
      const error: CIError = {
        message: "error",
        filePath: "file.go",
        line: 1,
        category: "lint",
        ruleId: "`rule`",
        source: "x",
      };
      const result = formatError(error);
      expect(result).toContain("Rule: 'rule'");
    });

    test("escapes backticks in source", () => {
      const error: CIError = {
        message: "error",
        filePath: "file.go",
        line: 1,
        category: "lint",
        ruleId: "rule",
        source: "const `x` = 1",
      };
      const result = formatError(error);
      expect(result).toContain("Source: const 'x' = 1");
    });
  });
});

describe("prioritizeErrors", () => {
  test("sorts by category priority (lower number first)", () => {
    const errors: CIError[] = [
      { message: "lint error", category: "lint" },
      { message: "compile error", category: "compile" },
      { message: "test error", category: "test" },
    ];
    const result = prioritizeErrors(errors);
    expect(result[0].category).toBe("compile");
    expect(result[1].category).toBe("test");
    expect(result[2].category).toBe("lint");
  });

  test("sorts by file path when categories are equal", () => {
    const errors: CIError[] = [
      { message: "error", category: "compile", filePath: "z.go" },
      { message: "error", category: "compile", filePath: "a.go" },
      { message: "error", category: "compile", filePath: "m.go" },
    ];
    const result = prioritizeErrors(errors);
    expect(result[0].filePath).toBe("a.go");
    expect(result[1].filePath).toBe("m.go");
    expect(result[2].filePath).toBe("z.go");
  });

  test("sorts by line number when category and file are equal", () => {
    const errors: CIError[] = [
      { message: "error", category: "compile", filePath: "a.go", line: 30 },
      { message: "error", category: "compile", filePath: "a.go", line: 10 },
      { message: "error", category: "compile", filePath: "a.go", line: 20 },
    ];
    const result = prioritizeErrors(errors);
    expect(result[0].line).toBe(10);
    expect(result[1].line).toBe(20);
    expect(result[2].line).toBe(30);
  });

  test("uses unknown category for missing category", () => {
    const errors: CIError[] = [
      { message: "error" },
      { message: "compile error", category: "compile" },
    ];
    const result = prioritizeErrors(errors);
    expect(result[0].category).toBe("compile");
    expect(result[1].category).toBeUndefined();
  });

  test("treats missing file path as empty string", () => {
    const errors: CIError[] = [
      { message: "error", category: "compile", filePath: "b.go" },
      { message: "error", category: "compile" },
      { message: "error", category: "compile", filePath: "a.go" },
    ];
    const result = prioritizeErrors(errors);
    expect(result[0].filePath).toBeUndefined();
    expect(result[1].filePath).toBe("a.go");
    expect(result[2].filePath).toBe("b.go");
  });

  test("treats missing line as 0", () => {
    const errors: CIError[] = [
      { message: "error", category: "compile", filePath: "a.go", line: 10 },
      { message: "error", category: "compile", filePath: "a.go" },
    ];
    const result = prioritizeErrors(errors);
    expect(result[0].line).toBeUndefined();
    expect(result[1].line).toBe(10);
  });

  test("does not mutate original array", () => {
    const errors: CIError[] = [
      { message: "lint error", category: "lint" },
      { message: "compile error", category: "compile" },
    ];
    const original = [...errors];
    prioritizeErrors(errors);
    expect(errors[0]).toBe(original[0]);
    expect(errors[1]).toBe(original[1]);
  });

  test("returns same reference for empty array", () => {
    const errors: CIError[] = [];
    const result = prioritizeErrors(errors);
    expect(result).toBe(errors);
  });

  test("handles single element array", () => {
    const errors: CIError[] = [{ message: "error", category: "compile" }];
    const result = prioritizeErrors(errors);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("compile");
  });

  test("complex multi-field sorting", () => {
    const errors: CIError[] = [
      { message: "1", category: "lint", filePath: "b.go", line: 10 },
      { message: "2", category: "compile", filePath: "a.go", line: 20 },
      { message: "3", category: "compile", filePath: "a.go", line: 10 },
      { message: "4", category: "lint", filePath: "a.go", line: 5 },
      { message: "5", category: "compile", filePath: "b.go", line: 5 },
    ];
    const result = prioritizeErrors(errors);
    expect(result.map((e) => e.message)).toEqual(["3", "2", "5", "4", "1"]);
  });
});

describe("formatErrors", () => {
  test("returns '(no errors)' for empty array", () => {
    const result = formatErrors([]);
    expect(result).toBe("(no errors)");
  });

  test("formats single error", () => {
    const errors: CIError[] = [
      {
        message: "undefined variable",
        filePath: "file.go",
        line: 10,
        category: "compile",
      },
    ];
    const result = formatErrors(errors);
    expect(result).toBe("[compile] file.go:10:1: undefined variable");
  });

  test("formats multiple errors with double newline separator", () => {
    const errors: CIError[] = [
      { message: "error 1", filePath: "a.go", line: 1, category: "compile" },
      { message: "error 2", filePath: "b.go", line: 2, category: "lint" },
    ];
    const result = formatErrors(errors);
    expect(result).toContain(
      "[compile] a.go:1:1: error 1\n\n[lint] b.go:2:1: error 2"
    );
  });

  test("sorts errors before formatting", () => {
    const errors: CIError[] = [
      { message: "lint error", category: "lint", filePath: "b.go", line: 1 },
      {
        message: "compile error",
        category: "compile",
        filePath: "a.go",
        line: 1,
      },
    ];
    const result = formatErrors(errors);
    expect(result).toMatch(COMPILE_THEN_LINT_PATTERN);
  });

  test("includes stack traces where applicable", () => {
    const errors: CIError[] = [
      {
        message: "panic",
        category: "runtime",
        filePath: "handler.go",
        line: 50,
        stackTrace: "at service.go:100",
      },
    ];
    const result = formatErrors(errors);
    expect(result).toContain("Stack trace:");
    expect(result).toContain("service.go:100");
  });
});

describe("countErrors", () => {
  test("returns zero counts for empty array", () => {
    const result = countErrors([]);
    expect(result).toEqual({ errorCount: 0, warningCount: 0 });
  });

  test("counts errors correctly", () => {
    const errors: CIError[] = [
      { message: "error 1", severity: "error" },
      { message: "error 2", severity: "error" },
      { message: "error 3", severity: "error" },
    ];
    const result = countErrors(errors);
    expect(result.errorCount).toBe(3);
    expect(result.warningCount).toBe(0);
  });

  test("counts warnings correctly", () => {
    const errors: CIError[] = [
      { message: "warning 1", severity: "warning" },
      { message: "warning 2", severity: "warning" },
    ];
    const result = countErrors(errors);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(2);
  });

  test("counts both errors and warnings", () => {
    const errors: CIError[] = [
      { message: "error", severity: "error" },
      { message: "warning", severity: "warning" },
      { message: "error 2", severity: "error" },
    ];
    const result = countErrors(errors);
    expect(result.errorCount).toBe(2);
    expect(result.warningCount).toBe(1);
  });

  test("does not count items without severity", () => {
    const errors: CIError[] = [
      { message: "no severity" },
      { message: "error", severity: "error" },
    ];
    const result = countErrors(errors);
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(0);
  });
});

describe("countByCategory", () => {
  test("returns zero counts for all categories on empty array", () => {
    const result = countByCategory([]);
    expect(result).toEqual({
      compile: 0,
      "type-check": 0,
      test: 0,
      runtime: 0,
      lint: 0,
      infrastructure: 0,
      metadata: 0,
      security: 0,
      dependency: 0,
      config: 0,
      docs: 0,
      unknown: 0,
    });
  });

  test("counts each category correctly", () => {
    const errors: CIError[] = [
      { message: "1", category: "compile" },
      { message: "2", category: "compile" },
      { message: "3", category: "lint" },
      { message: "4", category: "test" },
    ];
    const result = countByCategory(errors);
    expect(result.compile).toBe(2);
    expect(result.lint).toBe(1);
    expect(result.test).toBe(1);
    expect(result["type-check"]).toBe(0);
  });

  test("defaults missing category to unknown", () => {
    const errors: CIError[] = [
      { message: "no category" },
      { message: "also no category" },
    ];
    const result = countByCategory(errors);
    expect(result.unknown).toBe(2);
  });

  test("counts all category types", () => {
    const errors: CIError[] = [
      { message: "1", category: "compile" },
      { message: "2", category: "type-check" },
      { message: "3", category: "test" },
      { message: "4", category: "runtime" },
      { message: "5", category: "lint" },
      { message: "6", category: "infrastructure" },
      { message: "7", category: "metadata" },
      { message: "8", category: "security" },
      { message: "9", category: "dependency" },
      { message: "10", category: "config" },
      { message: "11", category: "docs" },
      { message: "12", category: "unknown" },
    ];
    const result = countByCategory(errors);
    expect(result.compile).toBe(1);
    expect(result["type-check"]).toBe(1);
    expect(result.test).toBe(1);
    expect(result.runtime).toBe(1);
    expect(result.lint).toBe(1);
    expect(result.infrastructure).toBe(1);
    expect(result.metadata).toBe(1);
    expect(result.security).toBe(1);
    expect(result.dependency).toBe(1);
    expect(result.config).toBe(1);
    expect(result.docs).toBe(1);
    expect(result.unknown).toBe(1);
  });

  test("handles undefined and empty category as unknown", () => {
    const errors: CIError[] = [
      { message: "1" },
      { message: "2", category: undefined },
    ];
    const result = countByCategory(errors);
    expect(result.unknown).toBe(2);
  });
});
