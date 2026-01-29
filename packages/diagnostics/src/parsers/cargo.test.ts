import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseCargo } from "./cargo.js";

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

describe("parseCargo", () => {
  test("parses NDJSON with mixed message types", () => {
    const result = parseCargo(readFixture("cargo.ndjson"));
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "column": 9,
          "filePath": "src/lib.rs",
          "fixable": true,
          "line": 3,
          "message": "unused variable: \`x\`",
          "ruleId": "unused_variables",
          "severity": "warning",
          "stackTrace": "warning: unused variable: \`x\`
       --> src/lib.rs:3:9
        |
      3 |     let x = 42;
        |         ^ help: if this is intentional, prefix it with an underscore: \`_x\`
        |
        = note: \`#[warn(unused_variables)]\` on by default

      ",
          "suggestions": [
            "note: \`#[warn(unused_variables)]\` on by default",
            "if this is intentional, prefix it with an underscore: \`_x\`",
          ],
        },
        {
          "column": 13,
          "filePath": "src/lib.rs",
          "fixable": false,
          "line": 8,
          "message": "cannot find value \`undefined_var\` in this scope: not found in this scope",
          "ruleId": "E0425",
          "severity": "error",
          "stackTrace": "error[E0425]: cannot find value \`undefined_var\` in this scope
       --> src/lib.rs:8:13
        |
      8 |     let y = undefined_var;
        |             ^^^^^^^^^^^^^ not found in this scope

      ",
          "suggestions": undefined,
        },
        {
          "column": 5,
          "filePath": "src/lib.rs",
          "fixable": true,
          "line": 1,
          "message": "unused import: \`std::collections::HashMap\`",
          "ruleId": "unused_imports",
          "severity": "warning",
          "stackTrace": "warning: unused import: \`std::collections::HashMap\`
       --> src/lib.rs:1:5
        |
      1 | use std::collections::HashMap;
        |     ^^^^^^^^^^^^^^^^^^^^^^^^^
        |
        = note: \`#[warn(unused_imports)]\` on by default
        = help: remove the whole \`use\` item

      ",
          "suggestions": [
            "note: \`#[warn(unused_imports)]\` on by default",
            "remove the whole \`use\` item",
          ],
        },
        {
          "column": 20,
          "filePath": "src/lib.rs",
          "fixable": false,
          "line": 12,
          "message": "mismatched types: expected \`i32\`, found \`&str\`",
          "ruleId": "E0308",
          "severity": "error",
          "stackTrace": "error[E0308]: mismatched types
        --> src/lib.rs:12:20
         |
      12 |     let num: i32 = "hello";
         |              ---   ^^^^^^^ expected \`i32\`, found \`&str\`
         |              |
         |              expected due to this
         |
         = note: expected type \`i32\`
                    found reference \`&'static str\`

      ",
          "suggestions": [
            "note: expected type \`i32\`",
            "note: found reference \`&'static str\`",
          ],
        },
        {
          "column": 5,
          "filePath": "src/lib.rs",
          "fixable": false,
          "line": 15,
          "message": "value assigned to \`result\` is never read",
          "ruleId": "unused_assignments",
          "severity": "warning",
          "stackTrace": "warning: value assigned to \`result\` is never read
        --> src/lib.rs:15:5
         |
      15 |     result = 100;
         |     ^^^^^^
         |
         = note: \`#[warn(unused_assignments)]\` on by default
         = help: maybe it is overwritten before being read?

      ",
          "suggestions": [
            "note: \`#[warn(unused_assignments)]\` on by default",
            "maybe it is overwritten before being read?",
          ],
        },
      ]
    `);
  });

  test("ignores non-compiler-message lines", () => {
    const input = [
      '{"reason":"compiler-artifact","package_id":"test","filenames":[]}',
      '{"reason":"build-script-executed","package_id":"test"}',
      '{"reason":"build-finished","success":true}',
    ].join("\n");

    const result = parseCargo(input);
    expect(result).toEqual([]);
  });

  test("ignores help level messages at top level", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "consider using let",
        level: "help",
        spans: [],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result).toEqual([]);
  });

  test("ignores note level messages at top level", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "for more info see...",
        level: "note",
        spans: [],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result).toEqual([]);
  });

  test("maps warning level to warning severity", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "unused variable",
        level: "warning",
        code: { code: "unused_variables" },
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.severity).toBe("warning");
  });

  test("maps error level to error severity", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "type mismatch",
        level: "error",
        code: { code: "E0308" },
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 5,
            column_start: 10,
            is_primary: true,
          },
        ],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.severity).toBe("error");
  });

  test("extracts help suggestions with replacement", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "unused variable",
        level: "warning",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [
          {
            message: "prefix with underscore",
            level: "help",
            spans: [
              {
                file_name: "src/main.rs",
                suggested_replacement: "_x",
                suggestion_applicability: "MachineApplicable",
                is_primary: true,
              },
            ],
            children: [],
          },
        ],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.suggestions).toMatchInlineSnapshot(`
      [
        "prefix with underscore: \`_x\`",
      ]
    `);
  });

  test("extracts help suggestions without replacement", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "warning message",
        level: "warning",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [
          {
            message: "maybe it is overwritten before being read?",
            level: "help",
            spans: [],
            children: [],
          },
        ],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.suggestions).toEqual([
      "maybe it is overwritten before being read?",
    ]);
  });

  test("extracts note messages from children", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "type error",
        level: "error",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [
          {
            message: "expected type `i32`",
            level: "note",
            spans: [],
            children: [],
          },
          {
            message: "found type `&str`",
            level: "note",
            spans: [],
            children: [],
          },
        ],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.suggestions).toEqual([
      "note: expected type `i32`",
      "note: found type `&str`",
    ]);
  });

  test("sets fixable=true for MachineApplicable suggestions", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "unused variable",
        level: "warning",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [
          {
            message: "rename",
            level: "help",
            spans: [
              {
                suggested_replacement: "_x",
                suggestion_applicability: "MachineApplicable",
                is_primary: true,
              },
            ],
            children: [],
          },
        ],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.fixable).toBe(true);
  });

  test("sets fixable=true for MaybeIncorrect suggestions", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "unused variable",
        level: "warning",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [
          {
            message: "try this",
            level: "help",
            spans: [
              {
                suggested_replacement: "something",
                suggestion_applicability: "MaybeIncorrect",
                is_primary: true,
              },
            ],
            children: [],
          },
        ],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.fixable).toBe(true);
  });

  test("sets fixable=false for HasPlaceholders suggestions", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "missing type",
        level: "error",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [
          {
            message: "add type annotation",
            level: "help",
            spans: [
              {
                suggested_replacement: "(...)",
                suggestion_applicability: "HasPlaceholders",
                is_primary: true,
              },
            ],
            children: [],
          },
        ],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.fixable).toBe(false);
  });

  test("sets fixable=false when no applicable suggestions", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "error with no fix",
        level: "error",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.fixable).toBe(false);
  });

  test("selects primary span for location", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "error message",
        level: "error",
        spans: [
          {
            file_name: "src/secondary.rs",
            line_start: 100,
            column_start: 50,
            is_primary: false,
          },
          {
            file_name: "src/primary.rs",
            line_start: 10,
            column_start: 5,
            is_primary: true,
          },
        ],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result[0]).toMatchObject({
      filePath: "src/primary.rs",
      line: 10,
      column: 5,
    });
  });

  test("appends span label to message when present", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "mismatched types",
        level: "error",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 5,
            column_start: 10,
            is_primary: true,
            label: "expected `i32`, found `&str`",
          },
        ],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.message).toBe(
      "mismatched types: expected `i32`, found `&str`"
    );
  });

  test("handles missing code field", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "warning without code",
        level: "warning",
        code: null,
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.ruleId).toBeUndefined();
  });

  test("handles empty spans", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "error without location",
        level: "error",
        spans: [],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result[0]).toMatchObject({
      message: "error without location",
      filePath: undefined,
      line: undefined,
      column: undefined,
    });
  });

  test("handles invalid JSON lines gracefully", () => {
    const input = [
      "not json at all",
      '{"reason":"compiler-message","message":{"message":"valid error","level":"error","spans":[{"file_name":"test.rs","line_start":1,"column_start":1,"is_primary":true}],"children":[]}}',
      "{invalid json}",
      "",
    ].join("\n");

    const result = parseCargo(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe("valid error");
  });

  test("includes rendered output as stackTrace", () => {
    const rendered = "error: something went wrong\n --> src/main.rs:1:1";
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "something went wrong",
        level: "error",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [],
        rendered,
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.stackTrace).toBe(rendered);
  });

  test("handles null rendered field", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "no rendered output",
        level: "error",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
        children: [],
        rendered: null,
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.stackTrace).toBeUndefined();
  });

  test("detects fixable from top-level spans", () => {
    const input = JSON.stringify({
      reason: "compiler-message",
      package_id: "test",
      message: {
        message: "can be fixed",
        level: "warning",
        spans: [
          {
            file_name: "src/main.rs",
            line_start: 1,
            column_start: 1,
            is_primary: true,
            suggestion_applicability: "MachineApplicable",
          },
        ],
        children: [],
      },
    });

    const result = parseCargo(input);
    expect(result[0]?.fixable).toBe(true);
  });

  describe("security", () => {
    test("handles path traversal in file_name", () => {
      const input = JSON.stringify({
        reason: "compiler-message",
        package_id: "test",
        message: {
          message: "error",
          level: "error",
          spans: [
            {
              file_name: "../../../etc/passwd",
              line_start: 1,
              column_start: 1,
              is_primary: true,
            },
          ],
          children: [],
        },
      });
      const result = parseCargo(input);
      expect(result[0]?.filePath).toBe("../../../etc/passwd");
    });

    test("handles null bytes in file path", () => {
      const input = JSON.stringify({
        reason: "compiler-message",
        package_id: "test",
        message: {
          message: "error",
          level: "error",
          spans: [
            {
              file_name: "src/main\x00.rs",
              line_start: 1,
              column_start: 1,
              is_primary: true,
            },
          ],
          children: [],
        },
      });
      const result = parseCargo(input);
      expect(result[0]?.filePath).toBe("src/main\x00.rs");
    });

    test("handles __proto__ pollution attempt in NDJSON", () => {
      const line =
        '{"reason":"compiler-message","__proto__":{"polluted":true},"message":{"message":"test","level":"error","spans":[{"file_name":"test.rs","line_start":1,"column_start":1,"is_primary":true}],"children":[]}}';
      const result = parseCargo(line);
      expect(result).toHaveLength(1);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test("handles very long message strings", () => {
      const longMessage = "x".repeat(100_000);
      const input = JSON.stringify({
        reason: "compiler-message",
        package_id: "test",
        message: {
          message: longMessage,
          level: "error",
          spans: [
            {
              file_name: "src/main.rs",
              line_start: 1,
              column_start: 1,
              is_primary: true,
            },
          ],
          children: [],
        },
      });
      const result = parseCargo(input);
      expect(result[0]?.message).toBe(longMessage);
    });

    test("handles many NDJSON lines without memory issues", () => {
      const lines = new Array(1000)
        .fill(
          JSON.stringify({
            reason: "compiler-message",
            package_id: "test",
            message: {
              message: "error",
              level: "error",
              spans: [
                {
                  file_name: "src/main.rs",
                  line_start: 1,
                  column_start: 1,
                  is_primary: true,
                },
              ],
              children: [],
            },
          })
        )
        .join("\n");
      const result = parseCargo(lines);
      expect(result).toHaveLength(1000);
    });

    test("handles deeply nested children without stack overflow", () => {
      let children: Array<{
        message: string;
        level: string;
        spans: never[];
        children: typeof children;
      }> = [];
      for (let i = 0; i < 50; i++) {
        children = [{ message: "nested", level: "note", spans: [], children }];
      }
      const input = JSON.stringify({
        reason: "compiler-message",
        package_id: "test",
        message: {
          message: "error",
          level: "error",
          spans: [
            {
              file_name: "src/main.rs",
              line_start: 1,
              column_start: 1,
              is_primary: true,
            },
          ],
          children,
        },
      });
      const result = parseCargo(input);
      expect(result).toHaveLength(1);
    });

    test("handles malformed JSON lines without crashing", () => {
      const lines = [
        '{"reason":"compiler-message","message":{"message":"valid","level":"error","spans":[{"file_name":"test.rs","line_start":1,"column_start":1,"is_primary":true}],"children":[]}}',
        '{"truncated json',
        "not json at all",
        '{"reason":"compiler-message","message":{"message":"also valid","level":"error","spans":[{"file_name":"test2.rs","line_start":1,"column_start":1,"is_primary":true}],"children":[]}}',
      ].join("\n");
      const result = parseCargo(lines);
      expect(result).toHaveLength(2);
    });
  });
});
