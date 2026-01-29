import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseTypeScript } from "./typescript.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "../__fixtures__");
const fixtureCache = new Map<string, string>();
const readFixture = (name: string) => {
  let content = fixtureCache.get(name);
  if (!content) {
    content = readFileSync(join(fixturesDir, name), "utf-8");
    fixtureCache.set(name, content);
  }
  return content;
};

describe("parseTypeScript", () => {
  describe("parenthesized format", () => {
    test("parses standard tsc output with parenthesized locations", () => {
      const result = parseTypeScript(readFixture("typescript-paren.txt"));
      expect(result).toMatchInlineSnapshot(`
        [
          {
            "column": 7,
            "filePath": "src/app.ts",
            "line": 1,
            "message": "Type 'string' is not assignable to type 'number'.",
            "ruleId": "TS2322",
            "severity": "error",
          },
          {
            "column": 7,
            "filePath": "src/app.ts",
            "line": 2,
            "message": "Type 'number' is not assignable to type 'string'.",
            "ruleId": "TS2322",
            "severity": "error",
          },
          {
            "column": 5,
            "filePath": "src/utils.ts",
            "line": 10,
            "message": "Cannot find name 'unknownVar'.",
            "ruleId": "TS2304",
            "severity": "error",
          },
          {
            "column": 12,
            "filePath": "src/components/button.tsx",
            "line": 42,
            "message": "Property 'onClick' does not exist on type 'Props'.",
            "ruleId": "TS2339",
            "severity": "error",
          },
          {
            "column": 3,
            "filePath": "lib/types.d.ts",
            "line": 5,
            "message": "Duplicate identifier 'Config'.",
            "ruleId": "TS2300",
            "severity": "error",
          },
          {
            "column": 8,
            "filePath": "src/server.mts",
            "line": 15,
            "message": "Cannot find module './missing' or its corresponding type declarations.",
            "ruleId": "TS2307",
            "severity": "error",
          },
          {
            "column": 10,
            "filePath": "src/client.cts",
            "line": 20,
            "message": "Parameter 'data' implicitly has an 'any' type.",
            "ruleId": "TS7006",
            "severity": "error",
          },
          {
            "column": 1,
            "filePath": "src/types.d.mts",
            "line": 3,
            "message": "Top-level declarations in .d.ts files must start with either a 'declare' or 'export' modifier.",
            "ruleId": "TS1046",
            "severity": "error",
          },
          {
            "column": 5,
            "filePath": "src/utils.d.cts",
            "line": 8,
            "message": "Type 'boolean' is not assignable to type 'void'.",
            "ruleId": "TS2322",
            "severity": "error",
          },
          {
            "column": 1,
            "filePath": "components/header.tsx",
            "line": 100,
            "message": "'unusedVar' is declared but its value is never read.",
            "ruleId": "TS6133",
            "severity": "warning",
          },
          {
            "column": 15,
            "filePath": "src/index.ts",
            "line": 50,
            "message": "Unknown compiler option 'strict-mode'.",
            "ruleId": "TS5023",
            "severity": "error",
          },
        ]
      `);
    });
  });

  describe("colon-separated format (pretty mode)", () => {
    test("parses pretty tsc output with ANSI codes stripped", () => {
      const result = parseTypeScript(readFixture("typescript-colon.txt"));
      expect(result).toMatchInlineSnapshot(`
        [
          {
            "column": 7,
            "filePath": "src/app.ts",
            "line": 1,
            "message": "Type 'string' is not assignable to type 'number'.",
            "ruleId": "TS2322",
            "severity": "error",
          },
          {
            "column": 7,
            "filePath": "src/client.cts",
            "line": 1,
            "message": "Type 'string' is not assignable to type 'boolean'.",
            "ruleId": "TS2322",
            "severity": "error",
          },
          {
            "column": 7,
            "filePath": "src/components/Button.tsx",
            "line": 1,
            "message": "Type 'number' is not assignable to type 'string'.",
            "ruleId": "TS2322",
            "severity": "error",
          },
          {
            "column": 49,
            "filePath": "src/server.mts",
            "line": 1,
            "message": "Type 'number' is not assignable to type 'string'.",
            "ruleId": "TS2322",
            "severity": "error",
          },
        ]
      `);
    });
  });

  describe("TypeScript file extensions", () => {
    test("parses .ts files", () => {
      const result = parseTypeScript("src/app.ts(1,1): error TS2322: message");
      expect(result[0]?.filePath).toBe("src/app.ts");
    });

    test("parses .tsx files", () => {
      const result = parseTypeScript(
        "components/button.tsx(1,1): error TS2322: message"
      );
      expect(result[0]?.filePath).toBe("components/button.tsx");
    });

    test("parses .mts files", () => {
      const result = parseTypeScript(
        "src/server.mts(1,1): error TS2322: message"
      );
      expect(result[0]?.filePath).toBe("src/server.mts");
    });

    test("parses .cts files", () => {
      const result = parseTypeScript(
        "src/client.cts(1,1): error TS2322: message"
      );
      expect(result[0]?.filePath).toBe("src/client.cts");
    });

    test("parses .d.ts files", () => {
      const result = parseTypeScript(
        "lib/types.d.ts(1,1): error TS2322: message"
      );
      expect(result[0]?.filePath).toBe("lib/types.d.ts");
    });

    test("parses .d.tsx files", () => {
      const result = parseTypeScript(
        "lib/types.d.tsx(1,1): error TS2322: message"
      );
      expect(result[0]?.filePath).toBe("lib/types.d.tsx");
    });

    test("parses .d.mts files", () => {
      const result = parseTypeScript(
        "lib/types.d.mts(1,1): error TS2322: message"
      );
      expect(result[0]?.filePath).toBe("lib/types.d.mts");
    });

    test("parses .d.cts files", () => {
      const result = parseTypeScript(
        "lib/types.d.cts(1,1): error TS2322: message"
      );
      expect(result[0]?.filePath).toBe("lib/types.d.cts");
    });
  });

  describe("severity detection", () => {
    test("detects error severity", () => {
      const result = parseTypeScript("file.ts(1,1): error TS2322: Type error");
      expect(result[0]?.severity).toBe("error");
    });

    test("detects warning severity", () => {
      const result = parseTypeScript(
        "file.ts(1,1): warning TS6133: Unused variable"
      );
      expect(result[0]?.severity).toBe("warning");
    });

    test("detects fatal error severity (maps to error)", () => {
      const result = parseTypeScript(
        "file.ts(1,1): fatal error TS5023: Unknown option"
      );
      expect(result[0]?.severity).toBe("error");
    });

    test("defaults to error when severity is missing", () => {
      const result = parseTypeScript("file.ts(1,1): TS2322: Type error");
      expect(result[0]?.severity).toBe("error");
    });
  });

  describe("error code extraction", () => {
    test("extracts TS error code", () => {
      const result = parseTypeScript("file.ts(1,1): error TS2322: Type error");
      expect(result[0]?.ruleId).toBe("TS2322");
    });

    test("handles missing error code", () => {
      const result = parseTypeScript("file.ts(1,1): error: Type error");
      expect(result[0]?.ruleId).toBeUndefined();
    });
  });

  describe("ANSI code stripping", () => {
    test("strips ANSI color codes from error lines (colon format)", () => {
      // Real ANSI escape codes as produced by tsc --pretty
      const input =
        "\u001b[96mfile.ts\u001b[0m:\u001b[93m1\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType mismatch";
      const result = parseTypeScript(input);
      expect(result[0]).toMatchInlineSnapshot(`
        {
          "column": 7,
          "filePath": "file.ts",
          "line": 1,
          "message": "Type mismatch",
          "ruleId": "TS2322",
          "severity": "error",
        }
      `);
    });

    test("strips ANSI color codes from error lines (paren format)", () => {
      const input =
        "\u001b[1m\u001b[31mfile.ts\u001b[0m(10,5): error TS2304: Cannot find name";
      const result = parseTypeScript(input);
      expect(result[0]?.filePath).toBe("file.ts");
      expect(result[0]?.line).toBe(10);
      expect(result[0]?.column).toBe(5);
    });

    test("handles multiple consecutive ANSI codes", () => {
      const input =
        "\u001b[1m\u001b[4m\u001b[31mfile.ts\u001b[0m\u001b[0m(1,1): error TS2322: Type error";
      const result = parseTypeScript(input);
      expect(result[0]?.filePath).toBe("file.ts");
      expect(result[0]?.message).toBe("Type error");
    });
  });

  describe("line location parsing", () => {
    test("extracts line and column numbers correctly", () => {
      const result = parseTypeScript(
        "file.ts(42,15): error TS2322: Type error"
      );
      expect(result[0]?.line).toBe(42);
      expect(result[0]?.column).toBe(15);
    });

    test("handles large line numbers", () => {
      const result = parseTypeScript(
        "file.ts(9999,100): error TS2322: Type error"
      );
      expect(result[0]?.line).toBe(9999);
      expect(result[0]?.column).toBe(100);
    });
  });

  describe("edge cases", () => {
    test("returns empty array for empty input", () => {
      expect(parseTypeScript("")).toEqual([]);
    });

    test("returns empty array for whitespace-only input", () => {
      expect(parseTypeScript("   \n   \n   ")).toEqual([]);
    });

    test("ignores non-error lines", () => {
      const input = `
Some build output...
Building project...
file.ts(1,1): error TS2322: Type error
Compilation complete.
      `;
      const result = parseTypeScript(input);
      expect(result).toHaveLength(1);
    });

    test("skips overly long lines (ReDoS protection)", () => {
      const longLine = `file.ts(1,1): error TS2322: ${"x".repeat(2001)}`;
      const result = parseTypeScript(longLine);
      expect(result).toEqual([]);
    });

    test("handles files with paths containing directories", () => {
      const result = parseTypeScript(
        "src/components/ui/button/index.tsx(1,1): error TS2322: Type error"
      );
      expect(result[0]?.filePath).toBe("src/components/ui/button/index.tsx");
    });

    test("trims message whitespace", () => {
      const result = parseTypeScript(
        "file.ts(1,1): error TS2322:   Spaced message   "
      );
      expect(result[0]?.message).toBe("Spaced message");
    });

    test("handles multiple errors on consecutive lines", () => {
      const input = `file.ts(1,1): error TS2322: First error
file.ts(2,1): error TS2322: Second error
file.ts(3,1): error TS2322: Third error`;
      const result = parseTypeScript(input);
      expect(result).toHaveLength(3);
      expect(result[0]?.line).toBe(1);
      expect(result[1]?.line).toBe(2);
      expect(result[2]?.line).toBe(3);
    });
  });

  describe("colon format specifics", () => {
    test("parses colon format with warning severity", () => {
      const input =
        "file.ts:10:5 - warning TS6133: 'x' is declared but never used.";
      const result = parseTypeScript(input);
      expect(result[0]).toMatchInlineSnapshot(`
        {
          "column": 5,
          "filePath": "file.ts",
          "line": 10,
          "message": "'x' is declared but never used.",
          "ruleId": "TS6133",
          "severity": "warning",
        }
      `);
    });

    test("parses colon format with fatal error severity", () => {
      const input =
        "file.ts:1:1 - fatal error TS5023: Unknown compiler option.";
      const result = parseTypeScript(input);
      expect(result[0]?.severity).toBe("error");
    });
  });

  describe("security", () => {
    test("handles path traversal attempts in filePath", () => {
      const result = parseTypeScript(
        "../../../etc/passwd.ts(1,1): error TS2322: message"
      );
      expect(result[0]?.filePath).toBe("../../../etc/passwd.ts");
    });

    test("processes exactly MAX_LINE_LENGTH characters", () => {
      const message = "x".repeat(1900);
      const line = `file.ts(1,1): error TS2322: ${message}`;
      expect(line.length).toBeLessThanOrEqual(2000);
      const result = parseTypeScript(line);
      expect(result).toHaveLength(1);
    });

    test("rejects line at MAX_LINE_LENGTH + 1", () => {
      const longLine = `file.ts(1,1): error TS2322: ${"x".repeat(2001)}`;
      expect(longLine.length).toBeGreaterThan(2000);
      const result = parseTypeScript(longLine);
      expect(result).toEqual([]);
    });

    test("handles unicode in file paths and messages", () => {
      const result = parseTypeScript(
        "src/コンポーネント/文件.ts(1,1): error TS2322: エラー: 型の不一致"
      );
      expect(result[0]?.filePath).toBe("src/コンポーネント/文件.ts");
      expect(result[0]?.message).toBe("エラー: 型の不一致");
    });

    test("handles crafted input attempting regex backtracking", () => {
      const craftedInput = `aaaa.ts${"(1,1)".repeat(100)}: error TS2322: msg`;
      const result = parseTypeScript(craftedInput);
      expect(Array.isArray(result)).toBe(true);
    });

    test("handles input with null bytes gracefully", () => {
      // Null bytes in input are preserved in the filename
      // The parser handles this without crashing
      const result = parseTypeScript(
        "file\x00inject.ts(1,1): error TS2322: message"
      );
      expect(result).toHaveLength(1);
      // The null byte is preserved in the parsed filename
      expect(result[0]?.filePath).toBe("file\x00inject.ts");
    });

    test("handles many lines without memory issues", () => {
      const lines = new Array(10_000)
        .fill("file.ts(1,1): error TS2322: Type error")
        .join("\n");
      const result = parseTypeScript(lines);
      expect(result).toHaveLength(10_000);
    });

    test("handles CRLF line endings", () => {
      const input =
        "file.ts(1,1): error TS2322: First\r\nfile.ts(2,1): error TS2322: Second";
      const result = parseTypeScript(input);
      expect(result).toHaveLength(2);
    });
  });
});
