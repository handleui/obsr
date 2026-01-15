import { beforeEach, describe, expect, it } from "vitest";
import { createParseContext, type ParseContext } from "../parser-types.js";
import { createVitestParser } from "../parsers/vitest.js";
import type { ExtractedError } from "../types.js";

describe("VitestParser", () => {
  let parser: ReturnType<typeof createVitestParser>;
  let ctx: ParseContext;

  beforeEach(() => {
    parser = createVitestParser();
    ctx = createParseContext();
  });

  describe("FAIL markers", () => {
    it("parses FAIL marker with test file path", () => {
      const line = "FAIL src/__tests__/math.test.ts";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe(
        "Test suite failed: src/__tests__/math.test.ts"
      );
      expect(result.file).toBe("src/__tests__/math.test.ts");
      expect(result.severity).toBe("error");
      expect(result.category).toBe("test");
      expect(result.source).toBe("vitest");
    });

    it("parses FAIL marker with leading whitespace", () => {
      const line = " FAIL  src/components/Button.spec.tsx";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("src/components/Button.spec.tsx");
    });

    it("parses FAIL marker with .mts extension", () => {
      const line = "FAIL tests/utils.test.mts";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("tests/utils.test.mts");
    });
  });

  describe("test file summaries", () => {
    it("parses test file with failure count using > symbol", () => {
      const line = " > src/__tests__/math.test.ts (5 tests | 2 failed)";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toContain("src/__tests__/math.test.ts");
      expect(result.message).toContain("2 failed");
      expect(result.file).toBe("src/__tests__/math.test.ts");
      expect(result.category).toBe("test");
      expect(result.source).toBe("vitest");
    });

    it("parses test file with failure count using unicode arrow", () => {
      const line = " ❯ src/__tests__/api.test.ts (10 tests | 3 failed)";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("src/__tests__/api.test.ts");
    });

    it("parses spec file with failure count", () => {
      const line = " ❯ components/Modal.spec.tsx (1 test | 1 failed)";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("components/Modal.spec.tsx");
    });
  });

  describe("failed test names", () => {
    it("parses failed test with x marker", () => {
      const line = " x should add two numbers correctly";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe(
        "Test failed: should add two numbers correctly"
      );
      expect(result.category).toBe("test");
      expect(result.source).toBe("vitest");
      expect(result.ruleId).toBe("should add two numbers correctly");
    });

    it("parses failed test with unicode x marker", () => {
      const line = " × throws error on invalid input";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe("Test failed: throws error on invalid input");
    });

    it("parses failed test with X marker (uppercase)", () => {
      const line = "   X nested test case fails";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe("Test failed: nested test case fails");
    });
  });

  describe("assertion errors", () => {
    it("parses AssertionError with message", () => {
      const line = "AssertionError: expected 5 to be 4";

      expect(parser.canParse(line, ctx)).toBeGreaterThan(0.9);
      parser.parse(line, ctx);

      // Should start multi-line mode
      expect(parser.continueMultiLine("  at /test/file.ts:10:5", ctx)).toBe(
        true
      );

      const result = parser.finishMultiLine(ctx) as ExtractedError;
      expect(result).not.toBeNull();
      expect(result.message).toContain("expected 5 to be 4");
      expect(result.severity).toBe("error");
      expect(result.category).toBe("test");
    });

    it("parses TypeError", () => {
      const line = "TypeError: Cannot read properties of undefined";

      parser.parse(line, ctx);
      const result = parser.finishMultiLine(ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toContain("TypeError");
      expect(result.message).toContain("Cannot read properties of undefined");
    });

    it("parses ReferenceError", () => {
      const line = "ReferenceError: foo is not defined";

      parser.parse(line, ctx);
      const result = parser.finishMultiLine(ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toContain("ReferenceError");
    });
  });

  describe("stack traces", () => {
    it("extracts file location from stack frame with unicode arrow", () => {
      const line = " ❯ /Users/dev/project/src/math.ts:42:10";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("/Users/dev/project/src/math.ts");
      expect(result.line).toBe(42);
      expect(result.column).toBe(10);
    });

    it("extracts file location from stack frame with at keyword", () => {
      const line = "    at /project/tests/utils.test.ts:15:20";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("/project/tests/utils.test.ts");
      expect(result.line).toBe(15);
      expect(result.column).toBe(20);
    });

    it("extracts file location from stack frame with function name", () => {
      const line = "    at Object.sum (/project/src/math.ts:10:5)";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("/project/src/math.ts");
      expect(result.line).toBe(10);
      expect(result.column).toBe(5);
    });

    it("accumulates stack frames in multi-line mode", () => {
      parser.parse("AssertionError: expected true to be false", ctx);

      expect(parser.continueMultiLine(" ❯ /test/first.ts:1:1", ctx)).toBe(true);
      expect(parser.continueMultiLine(" ❯ /test/second.ts:2:2", ctx)).toBe(
        true
      );

      const result = parser.finishMultiLine(ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.stackTrace).toContain("/test/first.ts");
      expect(result.file).toBe("/test/first.ts");
      expect(result.line).toBe(1);
    });
  });

  describe("multi-line error accumulation", () => {
    it("accumulates assertion error with diff output", () => {
      parser.parse("AssertionError: expected 5 to be 4", ctx);

      expect(parser.continueMultiLine("- Expected  4", ctx)).toBe(true);
      expect(parser.continueMultiLine("+ Received  5", ctx)).toBe(true);
      expect(parser.continueMultiLine(" ❯ /test/math.ts:10:5", ctx)).toBe(true);

      const result = parser.finishMultiLine(ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("/test/math.ts");
      expect(result.line).toBe(10);
    });

    it("ends multi-line on new FAIL marker", () => {
      parser.parse("AssertionError: first error", ctx);

      expect(parser.continueMultiLine("FAIL src/second.test.ts", ctx)).toBe(
        false
      );
    });

    it("ends multi-line on error block separator", () => {
      parser.parse("AssertionError: some error", ctx);

      expect(parser.continueMultiLine("⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯", ctx)).toBe(false);
    });

    it("ends multi-line on new assertion error", () => {
      parser.parse("AssertionError: first error", ctx);

      expect(parser.continueMultiLine("TypeError: second error", ctx)).toBe(
        false
      );
    });
  });

  describe("noise detection", () => {
    it("identifies passing tests as noise", () => {
      expect(parser.isNoise("✓ should pass")).toBe(true);
      expect(parser.isNoise("√ should pass")).toBe(true);
      expect(parser.isNoise("✔ should pass")).toBe(true);
    });

    it("identifies summary lines as noise", () => {
      expect(parser.isNoise("Test Files  8 passed (8)")).toBe(true);
      expect(parser.isNoise("Tests  408 passed (408)")).toBe(true);
      expect(parser.isNoise("Duration  1.23s")).toBe(true);
      expect(parser.isNoise("Start at  21:58:21")).toBe(true);
    });

    it("identifies PASS markers as noise", () => {
      expect(parser.isNoise("PASS src/utils.test.ts")).toBe(true);
    });

    it("identifies version headers as noise", () => {
      expect(parser.isNoise("Vitest v4.0.16")).toBe(true);
      expect(parser.isNoise("RUN v4.0.16 /path/to/project")).toBe(true);
    });

    it("identifies coverage output as noise", () => {
      expect(parser.isNoise("Coverage report")).toBe(true);
      expect(parser.isNoise("| File    | % Stmts |")).toBe(true);
    });

    it("identifies skipped test indicators as noise", () => {
      expect(parser.isNoise("⎯ skipped test")).toBe(true);
      expect(parser.isNoise("↓ skipped")).toBe(true);
    });

    it("identifies console output prefixes as noise", () => {
      expect(parser.isNoise("stdout | some log")).toBe(true);
      expect(parser.isNoise("stderr | some error")).toBe(true);
    });

    it("does NOT identify actual errors as noise", () => {
      expect(parser.isNoise("FAIL src/test.ts")).toBe(false);
      expect(parser.isNoise("AssertionError: expected 5 to be 4")).toBe(false);
      expect(parser.isNoise("× test failed")).toBe(false);
      expect(parser.isNoise(" ❯ /path/to/file.ts:10:5")).toBe(false);
    });

    it("identifies empty lines as noise", () => {
      expect(parser.isNoise("")).toBe(true);
      expect(parser.isNoise("   ")).toBe(true);
    });
  });

  describe("canParse confidence scores", () => {
    it("returns high confidence for FAIL markers", () => {
      expect(parser.canParse("FAIL src/math.test.ts", ctx)).toBeGreaterThan(
        0.9
      );
    });

    it("returns high confidence for assertion errors", () => {
      expect(
        parser.canParse("AssertionError: expected 5 to be 4", ctx)
      ).toBeGreaterThan(0.9);
    });

    it("returns medium confidence for failed test markers", () => {
      expect(parser.canParse("× test failed", ctx)).toBeGreaterThan(0.8);
    });

    it("returns medium confidence for stack frames", () => {
      expect(parser.canParse(" ❯ /path/file.ts:10:5", ctx)).toBeGreaterThan(
        0.7
      );
    });

    it("returns zero for non-vitest lines", () => {
      expect(parser.canParse("some random line", ctx)).toBe(0);
      expect(parser.canParse("", ctx)).toBe(0);
    });

    it("returns high confidence when in multi-line mode", () => {
      parser.parse("AssertionError: error", ctx);
      expect(
        parser.canParse("any line while in error mode", ctx)
      ).toBeGreaterThan(0.8);
    });
  });

  describe("parser reset", () => {
    it("clears state after reset", () => {
      parser.parse("AssertionError: error", ctx);
      parser.continueMultiLine(" ❯ /test.ts:1:1", ctx);

      parser.reset();

      // After reset, should not be in multi-line mode
      expect(parser.continueMultiLine("some line", ctx)).toBe(false);
    });

    it("resets after finishing multi-line", () => {
      parser.parse("AssertionError: error", ctx);
      parser.finishMultiLine(ctx);

      // After finish, should not be in multi-line mode
      expect(parser.continueMultiLine("some line", ctx)).toBe(false);
    });
  });

  describe("security - ReDoS prevention", () => {
    it("rejects overly long lines in canParse", () => {
      const veryLongLine = `FAIL ${"a".repeat(5000)}.test.ts`;
      expect(parser.canParse(veryLongLine, ctx)).toBe(0);
    });

    it("rejects overly long lines in parse", () => {
      const veryLongLine = `FAIL ${"a".repeat(5000)}.test.ts`;
      expect(parser.parse(veryLongLine, ctx)).toBeNull();
    });

    it("rejects overly long lines in continueMultiLine", () => {
      parser.parse("AssertionError: some error", ctx);
      const veryLongLine = `${"a".repeat(5000)}`;
      expect(parser.continueMultiLine(veryLongLine, ctx)).toBe(false);
    });

    it("parses test names at the 500 character boundary", () => {
      // Test name exactly 499 characters (should match - under limit)
      const testName499 = "a".repeat(499);
      const line499 = `× ${testName499}`;
      const result499 = parser.parse(line499, ctx);
      expect(result499).not.toBeNull();
      expect(result499?.message).toBe(`Test failed: ${testName499}`);

      parser.reset();

      // Test name exactly 500 characters (should match - at limit)
      const testName500 = "a".repeat(500);
      const line500 = `× ${testName500}`;
      const result500 = parser.parse(line500, ctx);
      expect(result500).not.toBeNull();
      expect(result500?.message).toBe(`Test failed: ${testName500}`);

      parser.reset();

      // Test name 501 characters (should NOT match - over limit)
      const testName501 = "a".repeat(501);
      const line501 = `× ${testName501}`;
      const result501 = parser.parse(line501, ctx);
      expect(result501).toBeNull();
    });

    it("enforces resource limits on multi-line accumulation", () => {
      parser.parse("AssertionError: some error", ctx);

      // Accumulate many lines to test MAX_RAW_LINES limit
      for (let i = 0; i < 600; i++) {
        if (!parser.continueMultiLine(`  line ${i}`, ctx)) {
          // Should stop before 600 due to MAX_RAW_LINES (500)
          expect(i).toBeLessThan(550);
          break;
        }
      }

      const result = parser.finishMultiLine(ctx);
      expect(result).not.toBeNull();
    });
  });

  describe("internal vitest frame filtering", () => {
    it("filters out stack frames from node_modules/@vitest/runner", () => {
      const line =
        " ❯ /home/runner/work/project/node_modules/@vitest/runner/dist/index.js:145:11";
      const result = parser.parse(line, ctx);

      expect(result).toBeNull();
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("filters out stack frames from bun cached @vitest packages", () => {
      const line =
        "    at file://home/runner/work/detent/detent/node_modules/bun/@vitest+runner@4.0.16/node_modules/@vitest/runner/dist/index.js:915:26";
      const result = parser.parse(line, ctx);

      expect(result).toBeNull();
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("filters out stack frames from node_modules/vitest", () => {
      const line = " ❯ /project/node_modules/vitest/dist/runner.js:100:15";
      const result = parser.parse(line, ctx);

      expect(result).toBeNull();
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("still parses user test file stack frames", () => {
      const line = " ❯ /project/src/__tests__/math.test.ts:42:10";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("/project/src/__tests__/math.test.ts");
      expect(result.line).toBe(42);
    });

    it("still parses user source file stack frames", () => {
      const line = " ❯ /project/src/utils/math.ts:15:5";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("/project/src/utils/math.ts");
      expect(result.line).toBe(15);
    });

    it("does not filter non-vitest node_modules frames", () => {
      // Other libraries in node_modules should still be shown
      // (they might be relevant to the user's error)
      const line = " ❯ /project/node_modules/lodash/debounce.js:50:20";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("/project/node_modules/lodash/debounce.js");
    });
  });

  describe("edge cases", () => {
    it("handles ANSI escape codes", () => {
      const line = "\x1b[31mFAIL\x1b[0m src/math.test.ts";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("src/math.test.ts");
    });

    it("handles various test file extensions", () => {
      const extensions = [
        "test.ts",
        "test.tsx",
        "test.js",
        "test.jsx",
        "spec.ts",
        "test.mts",
        "test.cjs",
      ];

      for (const ext of extensions) {
        parser.reset();
        const line = `FAIL src/file.${ext}`;
        const result = parser.parse(line, ctx) as ExtractedError;

        expect(result).not.toBeNull();
        expect(result.file).toBe(`src/file.${ext}`);
      }
    });

    it("handles relative file paths", () => {
      const line = " ❯ ./src/utils.ts:10:5";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("./src/utils.ts");
    });
  });

  describe("test output context tracking", () => {
    it("marks assertion errors as possiblyTestOutput when after stdout marker with test file", () => {
      // Observe the test output marker first
      parser.observeLine?.(
        "stdout | src/routes/webhooks.test.ts > webhooks > error handling"
      );

      // Parse an error in this context
      parser.parse("Error: Database error", ctx);
      const result = parser.finishMultiLine(ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.possiblyTestOutput).toBe(true);
    });

    it("marks assertion errors as possiblyTestOutput when after stderr marker with test file", () => {
      // Observe the test output marker first
      parser.observeLine?.(
        "stderr | src/routes/organizations.test.ts > edge cases > closes database connection on error"
      );

      // Parse an error in this context
      parser.parse("Error: Database error", ctx);
      const result = parser.finishMultiLine(ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.possiblyTestOutput).toBe(true);
    });

    it("does NOT mark assertion errors as possiblyTestOutput when NOT in test output context", () => {
      // No observeLine call with test marker, just parse directly
      parser.parse("Error: Some error", ctx);
      const result = parser.finishMultiLine(ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.possiblyTestOutput).toBeUndefined();
    });

    it("resets test context when stdout marker without test file appears", () => {
      // First, set test output context
      parser.observeLine?.("stderr | src/routes/test.test.ts > some test");

      // Then see a non-test marker, which should reset context
      parser.observeLine?.("stdout | some-other-file.ts");

      // Parse an error - should NOT have possiblyTestOutput
      parser.parse("Error: Some error", ctx);
      const result = parser.finishMultiLine(ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.possiblyTestOutput).toBeUndefined();
    });

    it("marks stack frames as possiblyTestOutput when in test output context", () => {
      // Observe the test output marker
      parser.observeLine?.("stdout | src/routes/test.test.ts > some test case");

      // Parse a standalone stack frame
      const result = parser.parse(
        " ❯ /project/src/test.ts:10:5",
        ctx
      ) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.possiblyTestOutput).toBe(true);
    });

    it("supports various test file extensions for test output markers", () => {
      const extensions = [
        "test.ts",
        "test.tsx",
        "spec.js",
        "spec.jsx",
        "test.mts",
        "spec.cjs",
      ];

      for (const ext of extensions) {
        parser.reset();
        parser.observeLine?.(`stderr | src/routes/file.${ext} > test name`);
        parser.parse("Error: Test error", ctx);
        const result = parser.finishMultiLine(ctx) as ExtractedError;

        expect(result).not.toBeNull();
        expect(result.possiblyTestOutput).toBe(true);
      }
    });

    it("clears test context on reset", () => {
      // Set test context
      parser.observeLine?.("stderr | src/routes/test.test.ts > test");

      // Reset should clear the context
      parser.reset();

      // Parse an error - should NOT have possiblyTestOutput
      parser.parse("Error: Some error", ctx);
      const result = parser.finishMultiLine(ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.possiblyTestOutput).toBeUndefined();
    });
  });
});
