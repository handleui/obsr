import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseVitest } from "./vitest.js";

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

describe("parseVitest", () => {
  test("parses nested test failures with ancestorTitles hierarchy", () => {
    const result = parseVitest(readFixture("vitest.json"));
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "column": 18,
          "filePath": "/project/src/services/user.test.ts",
          "line": 25,
          "message": "UserService createUser should validate email format: AssertionError: expected 'invalid-email' to match /^[^@]+@[^@]+\\.[^@]+$/",
          "severity": "error",
          "stackTrace": "AssertionError: expected 'invalid-email' to match /^[^@]+@[^@]+\\.[^@]+$/
          at /project/src/services/user.test.ts:25:18
          at processTicksAndRejections (node:internal/process/task_queues:95:5)",
        },
        {
          "column": 10,
          "filePath": "/project/src/services/user.test.ts",
          "line": 45,
          "message": "UserService deleteUser should throw if user not found: Error: Expected function to throw UserNotFoundError but it threw GenericError",
          "severity": "error",
          "stackTrace": "Error: Expected function to throw UserNotFoundError but it threw GenericError
          at Object.<anonymous> (/project/src/services/user.test.ts:45:10)",
        },
        {
          "column": 14,
          "filePath": "/project/src/api/users.test.ts",
          "line": 28,
          "message": "API > endpoints > POST /users > should return 400 on invalid input: AssertionError: expected 500 to equal 400",
          "severity": "error",
          "stackTrace": "AssertionError: expected 500 to equal 400
          at Context.<anonymous> (/project/src/api/users.test.ts:28:14)
          at processTicksAndRejections (node:internal/process/task_queues:95:5)
      Note: Response body was { error: 'Internal Server Error' }",
        },
      ]
    `);
  });

  test("uses fullName when available over ancestorTitles+title", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: ["Suite"],
              fullName: "Custom Full Name",
              title: "test title",
              status: "failed",
              failureMessages: ["Error message"],
              location: { line: 10, column: 5 },
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result[0]?.message).toMatchInlineSnapshot(
      `"Custom Full Name: Error message"`
    );
  });

  test("falls back to ancestorTitles+title when fullName is missing", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: ["Suite", "Nested"],
              title: "test title",
              status: "failed",
              failureMessages: ["Error message"],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result[0]?.message).toMatchInlineSnapshot(
      `"Suite > Nested > test title: Error message"`
    );
  });

  test("extracts location line and column", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: [],
              title: "test",
              status: "failed",
              failureMessages: ["Error"],
              location: { line: 42, column: 17 },
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result[0]).toMatchInlineSnapshot(`
      {
        "column": 17,
        "filePath": "/test/file.test.ts",
        "line": 42,
        "message": "test: Error",
        "severity": "error",
        "stackTrace": "Error",
      }
    `);
  });

  test("handles missing location gracefully", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: [],
              title: "test",
              status: "failed",
              failureMessages: ["Error"],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result[0]?.line).toBeUndefined();
    expect(result[0]?.column).toBeUndefined();
  });

  test("combines multiple failureMessages into stackTrace", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: [],
              title: "test",
              status: "failed",
              failureMessages: ["First error", "Second error", "Third error"],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result[0]?.stackTrace).toMatchInlineSnapshot(`
      "First error
      Second error
      Third error"
    `);
  });

  test("ignores passed tests", () => {
    const input = JSON.stringify({
      success: true,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "passed",
          assertionResults: [
            {
              ancestorTitles: [],
              title: "passing test",
              status: "passed",
              failureMessages: [],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result).toHaveLength(0);
  });

  test("ignores pending tests", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "pending",
          assertionResults: [
            {
              ancestorTitles: [],
              title: "skipped test",
              status: "pending",
              failureMessages: [],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result).toHaveLength(0);
  });

  test("ignores skipped tests", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "pending",
          assertionResults: [
            {
              ancestorTitles: [],
              title: "skipped test",
              status: "skipped",
              failureMessages: [],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result).toHaveLength(0);
  });

  test("ignores todo tests", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "pending",
          assertionResults: [
            {
              ancestorTitles: [],
              title: "todo test",
              status: "todo",
              failureMessages: [],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result).toHaveLength(0);
  });

  test("ignores failed tests without failureMessages", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: [],
              title: "failed but no message",
              status: "failed",
              failureMessages: [],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result).toHaveLength(0);
  });

  test("returns empty array for invalid JSON", () => {
    const result = parseVitest("not valid json");
    expect(result).toEqual([]);
  });

  test("returns empty array for empty testResults", () => {
    const input = JSON.stringify({
      success: true,
      testResults: [],
    });

    const result = parseVitest(input);
    expect(result).toEqual([]);
  });

  test("returns empty array when testResults is missing", () => {
    const input = JSON.stringify({
      success: true,
    });

    const result = parseVitest(input);
    expect(result).toEqual([]);
  });

  test("filters empty strings from ancestorTitles", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: ["", "Suite", ""],
              title: "test",
              status: "failed",
              failureMessages: ["Error"],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result[0]?.message).toMatchInlineSnapshot(`"Suite > test: Error"`);
  });

  test("handles multiline failure messages", () => {
    const input = JSON.stringify({
      success: false,
      testResults: [
        {
          name: "/test/file.test.ts",
          status: "failed",
          assertionResults: [
            {
              ancestorTitles: [],
              title: "test",
              status: "failed",
              failureMessages: [
                "AssertionError: expected 1 to equal 2\n    at file.test.ts:10:5\n    at runTest (vitest:123)",
              ],
            },
          ],
        },
      ],
    });

    const result = parseVitest(input);
    expect(result[0]?.message).toMatchInlineSnapshot(
      `"test: AssertionError: expected 1 to equal 2"`
    );
    expect(result[0]?.stackTrace).toMatchInlineSnapshot(`
      "AssertionError: expected 1 to equal 2
          at file.test.ts:10:5
          at runTest (vitest:123)"
    `);
  });

  describe("security", () => {
    test("handles path traversal in test file path", () => {
      const input = JSON.stringify({
        success: false,
        testResults: [
          {
            name: "../../../etc/passwd",
            status: "failed",
            assertionResults: [
              {
                ancestorTitles: [],
                title: "test",
                status: "failed",
                failureMessages: ["Error"],
              },
            ],
          },
        ],
      });
      const result = parseVitest(input);
      expect(result[0]?.filePath).toBe("../../../etc/passwd");
    });

    test("handles null bytes in file path", () => {
      const input = JSON.stringify({
        success: false,
        testResults: [
          {
            name: "/test/file\x00.test.ts",
            status: "failed",
            assertionResults: [
              {
                ancestorTitles: [],
                title: "test",
                status: "failed",
                failureMessages: ["Error"],
              },
            ],
          },
        ],
      });
      const result = parseVitest(input);
      expect(result[0]?.filePath).toBe("/test/file\x00.test.ts");
    });

    test("handles __proto__ pollution attempt", () => {
      const malicious =
        '{"__proto__": {"polluted": true}, "success": false, "testResults": []}';
      const result = parseVitest(malicious);
      expect(result).toEqual([]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test("handles deeply nested JSON", () => {
      let nested = '{"success": false, "testResults": []}';
      for (let i = 0; i < 100; i++) {
        nested = `{"nested": ${nested}}`;
      }
      const result = parseVitest(nested);
      expect(result).toEqual([]);
    });

    test("handles very long failure messages", () => {
      const longMessage = "x".repeat(100_000);
      const input = JSON.stringify({
        success: false,
        testResults: [
          {
            name: "/test/file.test.ts",
            status: "failed",
            assertionResults: [
              {
                ancestorTitles: [],
                title: "test",
                status: "failed",
                failureMessages: [longMessage],
              },
            ],
          },
        ],
      });
      const result = parseVitest(input);
      expect(result[0]?.stackTrace?.length).toBe(100_000);
    });

    test("handles many test results without memory issues", () => {
      const results = new Array(1000).fill(null).map((_, i) => ({
        name: `/test/file${i}.test.ts`,
        status: "failed",
        assertionResults: [
          {
            ancestorTitles: [],
            title: `test ${i}`,
            status: "failed",
            failureMessages: ["Error"],
          },
        ],
      }));
      const input = JSON.stringify({ success: false, testResults: results });
      const result = parseVitest(input);
      expect(result).toHaveLength(1000);
    });
  });
});
