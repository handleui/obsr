import { beforeEach, describe, expect, it } from "vitest";
import { createParseContext, type ParseContext } from "../parser-types.js";
import { createGitHubAnnotationParser } from "../parsers/github-annotations.js";
import type { ExtractedError } from "../types.js";

describe("GitHubAnnotationParser", () => {
  let parser: ReturnType<typeof createGitHubAnnotationParser>;
  let ctx: ParseContext;

  beforeEach(() => {
    parser = createGitHubAnnotationParser();
    ctx = createParseContext();
  });

  describe("::error:: annotations", () => {
    it("parses error annotation with file and line", () => {
      const line = "::error file=src/test.ts,line=42::Test failed";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe("Test failed");
      expect(result.file).toBe("src/test.ts");
      expect(result.line).toBe(42);
      expect(result.severity).toBe("error");
      expect(result.source).toBe("github-annotations");
    });

    it("parses error annotation with file, line, and column", () => {
      const line = "::error file=src/app.js,line=10,col=15::Missing semicolon";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe("Missing semicolon");
      expect(result.file).toBe("src/app.js");
      expect(result.line).toBe(10);
      expect(result.column).toBe(15);
    });

    it("parses error annotation with title", () => {
      const line =
        "::error file=src/test.ts,line=5,title=Assertion Error::Expected true to be false";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe("Expected true to be false");
      expect(result.ruleId).toBe("Assertion Error");
    });

    it("parses error annotation with column using 'column' instead of 'col'", () => {
      const line = "::error file=src/test.ts,line=5,column=10::Error message";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.column).toBe(10);
    });
  });

  describe("::warning:: annotations", () => {
    it("parses warning annotation with file and line", () => {
      const line = "::warning file=src/utils.ts,line=20::Unused variable";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe("Unused variable");
      expect(result.file).toBe("src/utils.ts");
      expect(result.line).toBe(20);
      expect(result.severity).toBe("warning");
    });
  });

  describe("::notice:: annotations", () => {
    it("parses notice annotation with file and line", () => {
      const line =
        "::notice file=README.md,line=1::Documentation update needed";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe("Documentation update needed");
      expect(result.file).toBe("README.md");
      expect(result.line).toBe(1);
      expect(result.severity).toBe("warning"); // notice maps to warning
    });
  });

  describe("canParse confidence scores", () => {
    it("returns high confidence for error annotation with file", () => {
      const line = "::error file=test.ts,line=1::message";
      expect(parser.canParse(line, ctx)).toBeGreaterThan(0.95);
    });

    it("returns zero for error annotation without file", () => {
      const line = "::error::Some error message";
      expect(parser.canParse(line, ctx)).toBe(0);
    });

    it("returns zero for non-annotation lines", () => {
      expect(parser.canParse("Error: Something failed", ctx)).toBe(0);
      expect(parser.canParse("file.ts:10:5: error", ctx)).toBe(0);
    });

    it("returns zero for debug/group workflow commands", () => {
      expect(parser.canParse("::debug::Debug message", ctx)).toBe(0);
      expect(parser.canParse("::group::Group name", ctx)).toBe(0);
    });
  });

  describe("category inference", () => {
    it("categorizes test file errors as test", () => {
      const line =
        "::error file=src/__tests__/app.test.ts,line=10::Assertion failed";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result.category).toBe("test");
    });

    it("categorizes spec file errors as test", () => {
      const line = "::error file=src/component.spec.tsx,line=5::Test failure";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result.category).toBe("test");
    });

    it("categorizes assertion errors as test", () => {
      const line =
        "::error file=src/app.ts,line=10::AssertionError: expected 5 to be 4";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result.category).toBe("test");
    });

    it("categorizes TypeScript errors as type-check", () => {
      const line =
        "::error file=src/app.ts,line=10::TS2339: Property does not exist";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result.category).toBe("type-check");
    });
  });

  describe("edge cases", () => {
    it("handles ANSI escape codes", () => {
      const line =
        "\x1b[31m::error file=src/test.ts,line=1::Error message\x1b[0m";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("src/test.ts");
    });

    it("handles paths with spaces", () => {
      const line =
        "::error file=src/my component/test.ts,line=1::Error message";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("src/my component/test.ts");
    });

    it("handles long messages", () => {
      const longMessage = "A".repeat(1000);
      const line = `::error file=test.ts,line=1::${longMessage}`;
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.message).toBe(longMessage);
    });

    it("rejects overly long lines", () => {
      const veryLongLine = `::error file=${"a".repeat(5000)}.ts,line=1::msg`;
      expect(parser.canParse(veryLongLine, ctx)).toBe(0);
      expect(parser.parse(veryLongLine, ctx)).toBeNull();
    });

    it("handles file-only annotation (no line)", () => {
      const line = "::error file=src/test.ts::Error without line";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("src/test.ts");
      expect(result.line).toBeUndefined();
      expect(result.lineKnown).toBe(false);
    });

    it("handles invalid line numbers gracefully (NaN)", () => {
      const line = "::error file=src/test.ts,line=abc,col=xyz::Error message";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("src/test.ts");
      expect(result.line).toBeUndefined();
      expect(result.column).toBeUndefined();
      expect(result.lineKnown).toBe(false);
      expect(result.columnKnown).toBe(false);
    });
  });

  describe("Vitest GitHub reporter output", () => {
    it("parses Vitest assertion error format", () => {
      const line =
        "::error file=src/lib/config.test.ts,line=45,title=project config > resolveProjectConfig > does nothing when config file does not exist::AssertionError: expected undefined to deeply equal {}";
      const result = parser.parse(line, ctx) as ExtractedError;

      expect(result).not.toBeNull();
      expect(result.file).toBe("src/lib/config.test.ts");
      expect(result.line).toBe(45);
      expect(result.ruleId).toBe(
        "project config > resolveProjectConfig > does nothing when config file does not exist"
      );
      expect(result.message).toBe(
        "AssertionError: expected undefined to deeply equal {}"
      );
      expect(result.category).toBe("test");
    });

    it("parses multiple Vitest errors", () => {
      const lines = [
        "::error file=src/test1.test.ts,line=10::Test 1 failed",
        "::error file=src/test2.test.ts,line=20::Test 2 failed",
      ];

      const results = lines.map((line) => parser.parse(line, ctx));

      expect(results[0]).not.toBeNull();
      expect(results[1]).not.toBeNull();
      expect((results[0] as ExtractedError).file).toBe("src/test1.test.ts");
      expect((results[1] as ExtractedError).file).toBe("src/test2.test.ts");
    });
  });
});
