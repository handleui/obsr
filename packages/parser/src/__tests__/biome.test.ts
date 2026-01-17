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
});
