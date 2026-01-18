import { beforeEach, describe, expect, it } from "vitest";
import { createParseContext, type ParseContext } from "../parser-types.js";
import { createBiomeParser } from "../parsers/biome.js";

describe("BiomeParser", () => {
  let parser: ReturnType<typeof createBiomeParser>;
  let ctx: ParseContext;

  beforeEach(() => {
    parser = createBiomeParser();
    ctx = createParseContext();
  });

  describe("factory function", () => {
    it("creates a parser instance", () => {
      const p = createBiomeParser();
      expect(p.id).toBe("biome");
      expect(p.priority).toBe(75);
    });

    it("does not support multi-line parsing", () => {
      expect(parser.supportsMultiLine()).toBe(false);
    });
  });

  describe("canParse - positive cases", () => {
    it("matches Biome lint errors", () => {
      const line =
        "::error title=lint/suspicious/noDoubleEquals,file=main.ts,line=4,col=3::Use === instead of ==";
      expect(parser.canParse(line, ctx)).toBeGreaterThan(0.9);
    });

    it("matches Biome lint warnings", () => {
      const line =
        "::warning title=lint/style/useConst,file=app.ts,line=10,col=1::Use const instead of let";
      expect(parser.canParse(line, ctx)).toBeGreaterThan(0.9);
    });

    it("matches Biome format errors", () => {
      const line =
        "::error title=format,file=src/index.ts,line=1,col=2::Formatter would have printed the following content";
      expect(parser.canParse(line, ctx)).toBeGreaterThan(0.9);
    });

    it("matches Biome organizeImports errors", () => {
      const line =
        "::error title=organizeImports,file=src/app.ts,line=1,col=1::Import organization needed";
      expect(parser.canParse(line, ctx)).toBeGreaterThan(0.9);
    });

    it("matches all lint categories", () => {
      const categories = [
        "lint/suspicious",
        "lint/style",
        "lint/a11y",
        "lint/complexity",
        "lint/correctness",
        "lint/performance",
        "lint/security",
        "lint/nursery",
      ];

      for (const category of categories) {
        const line = `::error title=${category}/someRule,file=test.ts,line=1,col=1::Some message`;
        expect(parser.canParse(line, ctx)).toBeGreaterThan(
          0.9,
          `Failed for category: ${category}`
        );
      }
    });
  });

  describe("canParse - negative cases (no bleeding)", () => {
    it("does NOT match generic ::error:: (no params)", () => {
      const line = "::error::Some error message";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match ::error without space", () => {
      const line = "::error::title=lint/foo,file=test.ts::message";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match non-Biome GitHub Actions errors", () => {
      const line = "::error file=test.js,line=1::Some other tool error";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match GitHub Actions error with wrong title prefix", () => {
      const line =
        "::error title=some-other-tool,file=test.js,line=1::Other error";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match GitHub Actions error without title", () => {
      const line = "::error file=main.ts,line=4,col=3::Generic error message";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match very short lines", () => {
      const line = "::error title=l";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match empty lines", () => {
      expect(parser.canParse("", ctx)).toBe(0);
    });
  });

  describe("parse - full extraction", () => {
    it("extracts all fields from lint error", () => {
      const line =
        "::error title=lint/suspicious/noDoubleEquals,file=main.ts,line=4,endLine=4,col=3,endColumn=5::Use === instead of ==";
      const result = parser.parse(line, ctx);

      expect(result).not.toBeNull();
      expect(result?.severity).toBe("error");
      expect(result?.ruleId).toBe("lint/suspicious/noDoubleEquals");
      expect(result?.filePath).toBe("main.ts");
      expect(result?.line).toBe(4);
      expect(result?.column).toBe(3);
      expect(result?.message).toBe("Use === instead of ==");
      expect(result?.category).toBe("lint");
      expect(result?.source).toBe("biome");
      expect(result?.lineKnown).toBe(true);
      expect(result?.columnKnown).toBe(true);
    });

    it("extracts warning severity", () => {
      const line =
        "::warning title=lint/style/useConst,file=app.ts,line=10,col=1::Use const instead of let";
      const result = parser.parse(line, ctx);

      expect(result).not.toBeNull();
      expect(result?.severity).toBe("warning");
      expect(result?.ruleId).toBe("lint/style/useConst");
    });

    it("extracts format errors", () => {
      const line =
        "::error title=format,file=src/index.ts,line=1,col=2::Formatter would have printed the following content";
      const result = parser.parse(line, ctx);

      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe("format");
      expect(result?.category).toBe("lint");
      expect(result?.filePath).toBe("src/index.ts");
    });

    it("extracts organizeImports errors", () => {
      const line =
        "::error title=organizeImports,file=src/app.ts,line=1,col=1::Import statements could be sorted";
      const result = parser.parse(line, ctx);

      expect(result).not.toBeNull();
      expect(result?.ruleId).toBe("organizeImports");
      expect(result?.category).toBe("lint");
    });

    it("handles file paths with directories", () => {
      const line =
        "::error title=lint/suspicious/noDebugger,file=src/components/Button.tsx,line=6,col=1::This is an unexpected use of the debugger statement";
      const result = parser.parse(line, ctx);

      expect(result?.filePath).toBe("src/components/Button.tsx");
    });

    it("handles messages with special characters", () => {
      const line =
        "::error title=lint/nursery/noEvolvingAny,file=main.ts,line=8,col=5::This variable's type is not allowed to evolve implicitly, leading to potential any types.";
      const result = parser.parse(line, ctx);

      expect(result?.message).toBe(
        "This variable's type is not allowed to evolve implicitly, leading to potential any types."
      );
    });
  });

  describe("parse - edge cases", () => {
    it("handles missing endLine and endColumn gracefully", () => {
      const line =
        "::error title=lint/suspicious/noDoubleEquals,file=main.ts,line=4,col=3::Use ===";
      const result = parser.parse(line, ctx);

      expect(result).not.toBeNull();
      expect(result?.line).toBe(4);
      expect(result?.column).toBe(3);
    });

    it("handles ANSI color codes", () => {
      const line =
        "\x1b[31m::error title=lint/suspicious/noDoubleEquals,file=main.ts,line=4,col=3::Use ===\x1b[0m";
      const result = parser.parse(line, ctx);

      expect(result).not.toBeNull();
      expect(result?.filePath).toBe("main.ts");
    });

    it("returns null for non-Biome GitHub Actions format", () => {
      const line = "::error file=test.js,line=1::Generic error";
      const result = parser.parse(line, ctx);

      expect(result).toBeNull();
    });

    it("preserves raw line in result", () => {
      const line =
        "::error title=lint/suspicious/noDoubleEquals,file=main.ts,line=4,col=3::Use ===";
      const result = parser.parse(line, ctx);

      expect(result?.raw).toBe(line);
    });
  });

  describe("isNoise", () => {
    it("identifies empty lines as noise", () => {
      expect(parser.isNoise("")).toBe(true);
      expect(parser.isNoise("   ")).toBe(true);
    });

    it("identifies success messages as noise", () => {
      expect(parser.isNoise("No errors found")).toBe(true);
      expect(parser.isNoise("Checked 42 files")).toBe(true);
      expect(parser.isNoise("Checked 100 files in 1.5s")).toBe(true);
    });

    it("does NOT mark error lines as noise", () => {
      expect(
        parser.isNoise(
          "::error title=lint/suspicious/noDoubleEquals,file=main.ts,line=4,col=3::Use ==="
        )
      ).toBe(false);
    });
  });

  describe("category mapping", () => {
    it("maps lint/* to lint category", () => {
      const line =
        "::error title=lint/suspicious/noDoubleEquals,file=test.ts,line=1,col=1::msg";
      const result = parser.parse(line, ctx);
      expect(result?.category).toBe("lint");
    });

    it("maps format to lint category", () => {
      const line =
        "::error title=format,file=test.ts,line=1,col=1::Formatter issue";
      const result = parser.parse(line, ctx);
      expect(result?.category).toBe("lint");
    });

    it("maps organizeImports to lint category", () => {
      const line =
        "::error title=organizeImports,file=test.ts,line=1,col=1::Import issue";
      const result = parser.parse(line, ctx);
      expect(result?.category).toBe("lint");
    });
  });

  describe("console format", () => {
    it("captures fixable from console format header", () => {
      const header =
        "test.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━";
      const message = "  × This variable is unused";

      expect(parser.canParse(header, ctx)).toBeGreaterThan(0.9);
      const result1 = parser.parse(header, ctx);
      expect(result1).toBeNull(); // waits for message line

      expect(parser.canParse(message, ctx)).toBeGreaterThan(0.9);
      const result2 = parser.parse(message, ctx);

      expect(result2).toMatchObject({
        fixable: true,
        ruleId: "lint/correctness/noUnusedVariables",
        filePath: "test.ts",
        line: 6,
        column: 7,
        message: "This variable is unused",
        source: "biome",
      });
    });

    it("handles non-fixable console errors", () => {
      const header = "test.ts:10:1 lint/suspicious/noDebugger  ━━━";
      const message = "  × Unexpected debugger statement";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(false);
      expect(result?.ruleId).toBe("lint/suspicious/noDebugger");
    });

    it("handles format errors in console format", () => {
      const header = "src/index.ts:1:1 format  FIXABLE  ━━━";
      const message = "  × Formatter would have printed different content";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
      expect(result?.ruleId).toBe("format");
    });

    it("handles organizeImports in console format", () => {
      const header = "src/app.ts:1:1 organizeImports  FIXABLE  ━━━";
      const message = "  × Import statements could be sorted";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
      expect(result?.ruleId).toBe("organizeImports");
      expect(result?.category).toBe("lint");
    });
  });

  describe("fixable - GitHub Actions format", () => {
    it("does not set fixable for GitHub Actions format", () => {
      const line =
        "::error title=lint/suspicious/noDoubleEquals,file=main.ts,line=4,col=3::Use ===";
      const result = parser.parse(line, ctx);

      // GitHub Actions format doesn't include fixable info
      expect(result?.fixable).toBeUndefined();
    });
  });

  describe("console format - fixable edge cases", () => {
    it("handles FIXABLE with multiple spaces around it", () => {
      const header =
        "test.ts:6:7 lint/correctness/noUnusedVariables    FIXABLE    ━━━";
      const message = "  × This variable is unused";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
    });

    it("handles FIXABLE with only one trailing space before box chars", () => {
      const header =
        "test.ts:6:7 lint/correctness/noUnusedVariables FIXABLE ━━━";
      const message = "  × This variable is unused";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
    });

    it("does NOT match lowercase 'fixable' (Biome uses uppercase)", () => {
      // Biome always outputs FIXABLE in uppercase, so lowercase should not match
      const header =
        "test.ts:6:7 lint/correctness/noUnusedVariables fixable ━━━";
      const message = "  × This variable is unused";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      // Should not be recognized as fixable
      expect(result?.fixable).toBe(false);
    });

    it("handles header without box-drawing chars suffix", () => {
      // Some terminal environments may strip or modify the box chars
      const header =
        "test.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ";
      const message = "  × This variable is unused";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
      expect(result?.ruleId).toBe("lint/correctness/noUnusedVariables");
    });

    it("handles ANSI color codes around FIXABLE marker", () => {
      // Biome may colorize the FIXABLE marker
      const header =
        "test.ts:6:7 lint/correctness/noUnusedVariables  \x1b[33mFIXABLE\x1b[0m  ━━━";
      const message = "  × This variable is unused";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
    });

    it("handles headers with unicode box-drawing variants", () => {
      // Different box-drawing characters that Biome might use
      const header =
        "test.ts:6:7 lint/style/useConst  FIXABLE  ───────────────";
      const message = "  × Use const instead of let";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
    });

    it("correctly identifies non-fixable when FIXABLE word appears in rule name", () => {
      // Edge case: what if a rule name contained "FIXABLE"
      // This is hypothetical but tests pattern robustness
      const header = "test.ts:6:7 lint/suspicious/noDebugger  ━━━";
      const message = "  × FIXABLE text in error message";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      // The FIXABLE is in the message, not the header position
      expect(result?.fixable).toBe(false);
      expect(result?.message).toBe("FIXABLE text in error message");
    });

    it("handles ✕ (U+2715) character for error lines", () => {
      const header =
        "test.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━";
      const message = "  ✕ This variable is unused";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
      expect(result?.message).toBe("This variable is unused");
    });
  });

  describe("console format - negative cases (no false positives)", () => {
    it("does NOT match generic file:line:col format without Biome rules", () => {
      // Other tools might use similar format
      const line = "test.ts:6:7 some-other-tool/rule  ━━━";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match TypeScript-style errors", () => {
      const line = "test.ts(6,7): error TS2322: Type mismatch";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match ESLint-style errors", () => {
      const line = "test.ts:6:7: error @typescript-eslint/no-unused-vars";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match Go compiler errors", () => {
      const line = "main.go:10:5: undefined: someFunc";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match Rust errors", () => {
      const line = "error[E0308]: mismatched types";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("does NOT match random × character outside Biome context", () => {
      // Without a pending header, × lines should not match
      const line = "  × some random error";
      expect(parser.canParse(line, ctx)).toBe(0);
    });
  });

  describe("console format - multiple tags support", () => {
    it("handles DEPRECATED tag", () => {
      const header = "test.ts:6:7 lint/style/useDeprecated  DEPRECATED  ━━━";
      const message = "  × This API is deprecated";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(false);
      expect(result?.ruleId).toBe("lint/style/useDeprecated");
    });

    it("handles DEPRECATED and FIXABLE tags together", () => {
      const header =
        "test.ts:6:7 lint/style/useDeprecated  DEPRECATED  FIXABLE  ━━━";
      const message = "  × This API is deprecated";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
      expect(result?.ruleId).toBe("lint/style/useDeprecated");
    });

    it("handles INTERNAL tag (internal Biome error)", () => {
      const header = "test.ts:6:7 lint/suspicious/noDebugger  INTERNAL  ━━━";
      const message = "  × Internal parser error";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(false);
      expect(result?.ruleId).toBe("lint/suspicious/noDebugger");
    });

    it("handles VERBOSE tag", () => {
      const header =
        "test.ts:6:7 lint/performance/noAccumulatingSpread  VERBOSE  ━━━";
      const message = "  × Avoid accumulating spreads in loops";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(false);
    });

    it("handles all tags together", () => {
      const header =
        "test.ts:6:7 lint/style/useConst  INTERNAL  FIXABLE  DEPRECATED  VERBOSE  ━━━";
      const message = "  × Use const";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
    });

    it("handles tags in different order", () => {
      const header =
        "test.ts:6:7 lint/style/useConst  FIXABLE  DEPRECATED  ━━━";
      const message = "  × Use const";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      expect(result?.fixable).toBe(true);
    });
  });

  describe("parser state isolation", () => {
    it("does not carry pending state between parse calls after reset", () => {
      const header =
        "test.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━";

      // Parse header (sets pending state)
      parser.parse(header, ctx);

      // Reset the parser
      parser.reset();

      // Now parsing a message line should not produce a result
      const message = "  × This variable is unused";
      const result = parser.parse(message, ctx);

      expect(result).toBeNull();
    });

    it("clears pending state when a new header is parsed", () => {
      const header1 =
        "test.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━";
      const header2 = "other.ts:10:1 lint/suspicious/noDebugger  ━━━";
      const message = "  × Unexpected debugger statement";

      // Parse first header
      parser.parse(header1, ctx);

      // Parse second header (should replace first)
      parser.parse(header2, ctx);

      // Parse message - should use second header's info
      const result = parser.parse(message, ctx);

      expect(result?.filePath).toBe("other.ts");
      expect(result?.ruleId).toBe("lint/suspicious/noDebugger");
      expect(result?.fixable).toBe(false); // second header has no FIXABLE
    });
  });

  describe("context line capture", () => {
    it("captures code context lines after console format error", () => {
      const header =
        "test.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━";
      const message = "  × This variable is unused";
      const contextLine1 = "    5 │ const foo = 'bar';";
      const contextLine2 = "    6 │ const unused = 123;";
      const contextLine3 = "      │       ^^^^^^";

      // Parse header and message to get the error
      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);

      // The error is emitted, now parse context lines
      parser.parse(contextLine1, ctx);
      parser.parse(contextLine2, ctx);
      parser.parse(contextLine3, ctx);

      // Flush by parsing a non-context line or calling reset
      parser.reset();

      // The context should be appended to the error's raw field
      expect(result?.raw).toContain(header);
      expect(result?.raw).toContain(message);
      expect(result?.raw).toContain(contextLine1);
      expect(result?.raw).toContain(contextLine2);
      expect(result?.raw).toContain(contextLine3);
    });

    it("flushes context when a new header is encountered", () => {
      const header1 =
        "test.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━";
      const message1 = "  × This variable is unused";
      const contextLine = "    6 │ const unused = 123;";
      const header2 = "other.ts:10:1 lint/suspicious/noDebugger  ━━━";
      const message2 = "  × Debugger statement";

      // Parse first error with context
      parser.parse(header1, ctx);
      const result1 = parser.parse(message1, ctx);
      parser.parse(contextLine, ctx);

      // Parse second error - should flush context to first error
      parser.parse(header2, ctx);
      const result2 = parser.parse(message2, ctx);

      // First error should have the context
      expect(result1?.raw).toContain(contextLine);

      // Second error should NOT have the first error's context
      expect(result2?.raw).not.toContain(contextLine);
    });

    it("captures info lines as context", () => {
      const header = "test.ts:6:7 lint/style/useConst  FIXABLE  ━━━";
      const message = "  × Use const instead of let";
      const infoLine = "  ℹ This variable is never reassigned";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);
      parser.parse(infoLine, ctx);
      parser.reset();

      expect(result?.raw).toContain(infoLine);
    });

    it("captures diff format lines as context", () => {
      const header = "test.ts:1:1 format  FIXABLE  ━━━";
      const message = "  × Formatter would have printed different content";
      const diffLine1 = "  1  1 │ const a = 1;";
      const diffLine2 = "  2    │ -const b = 2;";
      const diffLine3 = "     2 │ +const b = 3;";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);
      parser.parse(diffLine1, ctx);
      parser.parse(diffLine2, ctx);
      parser.parse(diffLine3, ctx);
      parser.reset();

      expect(result?.raw).toContain(diffLine1);
    });

    it("stops capturing context on non-context line", () => {
      const header = "test.ts:6:7 lint/correctness/noUnusedVariables  ━━━";
      const message = "  × This variable is unused";
      const contextLine = "    6 │ const unused = 123;";
      const nonContextLine = "some random output";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);
      parser.parse(contextLine, ctx);
      parser.parse(nonContextLine, ctx); // Should flush context

      // Context should already be flushed
      expect(result?.raw).toContain(contextLine);
    });

    it("reset clears context accumulator", () => {
      const header = "test.ts:6:7 lint/correctness/noUnusedVariables  ━━━";
      const message = "  × This variable is unused";
      const contextLine1 = "    6 │ const unused = 123;";
      const contextLine2 = "    7 │ // more code";

      parser.parse(header, ctx);
      const result = parser.parse(message, ctx);
      parser.parse(contextLine1, ctx);

      // Reset should flush accumulated context
      parser.reset();

      // Parse another context line - should NOT be captured since accumulator is cleared
      parser.parse(contextLine2, ctx);

      // First context line should be in the result
      expect(result?.raw).toContain(contextLine1);
      // Second context line should NOT be in the result (accumulator was cleared)
      expect(result?.raw).not.toContain(contextLine2);
    });
  });
});
