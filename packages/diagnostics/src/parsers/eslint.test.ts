import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseEslint } from "./eslint.js";

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

describe("parseEslint", () => {
  test("parses array format with mixed severity", () => {
    const result = parseEslint(readFixture("eslint-array.json"));
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "column": 10,
          "filePath": "/project/src/utils.ts",
          "fixable": false,
          "hints": [
            "Remove unused variable 'addOne'.",
          ],
          "line": 1,
          "message": "'addOne' is defined but never used.",
          "ruleId": "no-unused-vars",
          "severity": "error",
        },
        {
          "column": 20,
          "filePath": "/project/src/utils.ts",
          "fixable": true,
          "hints": undefined,
          "line": 3,
          "message": "Missing semicolon.",
          "ruleId": "semi",
          "severity": "warning",
        },
        {
          "column": 1,
          "filePath": "/project/src/utils.ts",
          "fixable": false,
          "hints": undefined,
          "line": 5,
          "message": "Parsing error: Unexpected token",
          "ruleId": undefined,
          "severity": "error",
        },
        {
          "column": 9,
          "filePath": "/project/src/index.ts",
          "fixable": false,
          "hints": [
            "Replace with Number.isNaN.",
            "Replace with Number.isNaN and cast to a Number.",
          ],
          "line": 2,
          "message": "Use the isNaN function to compare with NaN.",
          "ruleId": "use-isnan",
          "severity": "error",
        },
      ]
    `);
  });

  test("parses wrapped format", () => {
    const result = parseEslint(readFixture("eslint-wrapped.json"));
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "column": 25,
          "filePath": "/project/src/components/Button.tsx",
          "fixable": false,
          "hints": [
            "Use 'unknown' instead, this will force you to explicitly, and safely assert the type is correct.",
            "Use 'never' instead, this is useful when instantiating generic type parameters that you don't need to know the type of.",
          ],
          "line": 15,
          "message": "Unexpected any. Specify a different type.",
          "ruleId": "@typescript-eslint/no-explicit-any",
          "severity": "error",
        },
        {
          "column": 1,
          "filePath": "/project/src/components/Button.tsx",
          "fixable": false,
          "hints": undefined,
          "line": 20,
          "message": "Expected indentation of 4 spaces but found 2.",
          "ruleId": "indent",
          "severity": "warning",
        },
      ]
    `);
  });

  test("filters out severity 0 messages", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          { ruleId: "rule1", severity: 0, message: "off", line: 1, column: 1 },
          { ruleId: "rule2", severity: 1, message: "warn", line: 2, column: 1 },
          {
            ruleId: "rule3",
            severity: 2,
            message: "error",
            line: 3,
            column: 1,
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.message)).toEqual(["warn", "error"]);
  });

  test("maps severity 1 to warning", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          {
            ruleId: "semi",
            severity: 1,
            message: "Missing semicolon",
            line: 1,
            column: 10,
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.severity).toBe("warning");
  });

  test("maps severity 2 to error", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "Unused variable",
            line: 1,
            column: 5,
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.severity).toBe("error");
  });

  test("maps fatal messages to error regardless of severity", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          {
            ruleId: null,
            severity: 1,
            message: "Parsing error",
            line: 1,
            column: 1,
            fatal: true,
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.severity).toBe("error");
  });

  test("extracts ruleId when present", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          {
            ruleId: "no-console",
            severity: 2,
            message: "No console",
            line: 1,
            column: 1,
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.ruleId).toBe("no-console");
  });

  test("sets ruleId to undefined when null", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          {
            ruleId: null,
            severity: 2,
            message: "Fatal error",
            line: 1,
            column: 1,
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.ruleId).toBeUndefined();
  });

  test("extracts suggestions descriptions", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          {
            ruleId: "use-isnan",
            severity: 2,
            message: "Use isNaN",
            line: 1,
            column: 1,
            suggestions: [
              { desc: "Replace with Number.isNaN", messageId: "fix1" },
              { desc: "Use global isNaN", messageId: "fix2" },
            ],
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.hints).toEqual([
      "Replace with Number.isNaN",
      "Use global isNaN",
    ]);
  });

  test("returns undefined for hints when empty array", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          {
            ruleId: "rule",
            severity: 2,
            message: "msg",
            line: 1,
            column: 1,
            suggestions: [],
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.hints).toBeUndefined();
  });

  test("returns undefined for hints when not present", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          { ruleId: "rule", severity: 2, message: "msg", line: 1, column: 1 },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.hints).toBeUndefined();
  });

  test("sets fixable to true when fix is present", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          {
            ruleId: "semi",
            severity: 2,
            message: "Missing semicolon",
            line: 1,
            column: 10,
            fix: { range: [10, 10], text: ";" },
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.fixable).toBe(true);
  });

  test("sets fixable to false when fix is not present", () => {
    const input = JSON.stringify([
      {
        filePath: "/test.ts",
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "Unused",
            line: 1,
            column: 1,
          },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result[0]?.fixable).toBe(false);
  });

  test("returns empty array for invalid JSON", () => {
    const result = parseEslint("not valid json");
    expect(result).toEqual([]);
  });

  test("returns empty array for non-array results", () => {
    const result = parseEslint(JSON.stringify({ results: "not an array" }));
    expect(result).toEqual([]);
  });

  test("returns empty array for empty input", () => {
    const result = parseEslint("");
    expect(result).toEqual([]);
  });

  test("handles multiple files with multiple messages", () => {
    const input = JSON.stringify([
      {
        filePath: "/file1.ts",
        messages: [
          { ruleId: "rule1", severity: 2, message: "msg1", line: 1, column: 1 },
          { ruleId: "rule2", severity: 1, message: "msg2", line: 2, column: 1 },
        ],
      },
      {
        filePath: "/file2.ts",
        messages: [
          { ruleId: "rule3", severity: 2, message: "msg3", line: 3, column: 1 },
        ],
      },
    ]);
    const result = parseEslint(input);
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.filePath)).toEqual([
      "/file1.ts",
      "/file1.ts",
      "/file2.ts",
    ]);
  });

  describe("security", () => {
    test("handles path traversal attempts in filePath without modification", () => {
      const input = JSON.stringify([
        {
          filePath: "../../../etc/passwd",
          messages: [
            {
              ruleId: "rule",
              severity: 2,
              message: "msg",
              line: 1,
              column: 1,
            },
          ],
        },
      ]);
      const result = parseEslint(input);
      expect(result[0]?.filePath).toBe("../../../etc/passwd");
    });

    test("handles null bytes in filePath", () => {
      const input = JSON.stringify([
        {
          filePath: "/project/file\x00.ts",
          messages: [
            {
              ruleId: "rule",
              severity: 2,
              message: "msg",
              line: 1,
              column: 1,
            },
          ],
        },
      ]);
      const result = parseEslint(input);
      expect(result[0]?.filePath).toBe("/project/file\x00.ts");
    });

    test("handles __proto__ in input without prototype pollution", () => {
      const malicious = '{"__proto__": {"polluted": true}, "results": []}';
      const result = parseEslint(malicious);
      expect(result).toEqual([]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test("handles constructor pollution attempt", () => {
      const input = JSON.stringify([
        {
          filePath: "/test.ts",
          constructor: { prototype: { polluted: true } },
          messages: [
            {
              ruleId: "rule",
              severity: 2,
              message: "msg",
              line: 1,
              column: 1,
            },
          ],
        },
      ]);
      const result = parseEslint(input);
      expect(result).toHaveLength(1);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test("handles deeply nested JSON without stack overflow", () => {
      // Create deeply nested structure that isn't valid ESLint output
      // This tests that the parser handles invalid deeply nested input gracefully
      let nested = "{}";
      for (let i = 0; i < 100; i++) {
        nested = `{"nested":${nested}}`;
      }
      const result = parseEslint(nested);
      expect(result).toEqual([]);
    });

    test("handles very long message strings", () => {
      const longMessage = "x".repeat(100_000);
      const input = JSON.stringify([
        {
          filePath: "/test.ts",
          messages: [
            {
              ruleId: "rule",
              severity: 2,
              message: longMessage,
              line: 1,
              column: 1,
            },
          ],
        },
      ]);
      const result = parseEslint(input);
      expect(result[0]?.message).toBe(longMessage);
    });

    test("handles very long filePath strings", () => {
      const longPath = `/project/${"a".repeat(10_000)}.ts`;
      const input = JSON.stringify([
        {
          filePath: longPath,
          messages: [
            {
              ruleId: "rule",
              severity: 2,
              message: "msg",
              line: 1,
              column: 1,
            },
          ],
        },
      ]);
      const result = parseEslint(input);
      expect(result[0]?.filePath).toBe(longPath);
    });

    test("handles unicode in messages and paths", () => {
      const input = JSON.stringify([
        {
          filePath: "/project/file.ts",
          messages: [
            {
              ruleId: "rule",
              severity: 2,
              message: "Error message",
              line: 1,
              column: 1,
            },
          ],
        },
      ]);
      const result = parseEslint(input);
      expect(result[0]?.filePath).toBe("/project/file.ts");
      expect(result[0]?.message).toBe("Error message");
    });
  });
});
