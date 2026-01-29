import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseGolangci } from "./golangci.js";

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

describe("parseGolangci", () => {
  test("parses legacy format with Replacement", () => {
    const result = parseGolangci(readFixture("golangci-legacy.json"));
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "column": 8,
          "filePath": "pkg/handler/file.go",
          "fixable": false,
          "line": 45,
          "message": "Error return value of \`file.Close\` is not checked",
          "ruleId": "errcheck",
          "severity": "error",
          "stackTrace": "defer file.Close()",
          "suggestions": undefined,
        },
        {
          "column": 1,
          "filePath": "pkg/service/format.go",
          "fixable": true,
          "line": 10,
          "message": "File is not \`gofmt\`-ed with \`-s\`",
          "ruleId": "gofmt",
          "severity": "warning",
          "stackTrace": "func foo()  {
      return",
          "suggestions": [
            "Replace with: func foo() {
      	return",
          ],
        },
        {
          "column": undefined,
          "filePath": "pkg/utils/helpers.go",
          "fixable": true,
          "line": 25,
          "message": "\`unusedFunc\` is unused",
          "ruleId": "deadcode",
          "severity": "warning",
          "stackTrace": "func unusedFunc() {}",
          "suggestions": [
            "Delete this code",
          ],
        },
        {
          "column": 2,
          "filePath": "pkg/service/process.go",
          "fixable": false,
          "line": 123,
          "message": "this value of err is never used (SA4006)",
          "ruleId": "staticcheck",
          "severity": "error",
          "stackTrace": "err := process()",
          "suggestions": undefined,
        },
      ]
    `);
  });

  test("parses modern format with SuggestedFixes", () => {
    const result = parseGolangci(readFixture("golangci-modern.json"));
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "column": 12,
          "filePath": "cmd/main.go",
          "fixable": true,
          "line": 15,
          "message": "printf: fmt.Sprintf format %d has arg str of wrong type string",
          "ruleId": "govet",
          "severity": "error",
          "stackTrace": "fmt.Sprintf("%d", str)",
          "suggestions": [
            "Use %s for string arguments",
          ],
        },
        {
          "column": 2,
          "filePath": "internal/worker/pool.go",
          "fixable": true,
          "line": 78,
          "message": "S1000: should use a simple channel send/receive instead of \`select\` with a single case",
          "ruleId": "gosimple",
          "severity": "warning",
          "stackTrace": "select {
      case <-ch:
      }",
          "suggestions": [
            "Simplify to: <-ch",
          ],
        },
        {
          "column": 1,
          "filePath": "pkg/api/handler.go",
          "fixable": false,
          "line": 42,
          "message": "ineffectual assignment to err",
          "ruleId": "ineffassign",
          "severity": "warning",
          "stackTrace": "err = nil",
          "suggestions": undefined,
        },
        {
          "column": 6,
          "filePath": "pkg/public/api.go",
          "fixable": true,
          "line": 30,
          "message": "exported function DoSomething should have comment or be unexported",
          "ruleId": "revive",
          "severity": "warning",
          "suggestions": [
            "Add documentation comment",
            "Make function unexported",
          ],
        },
      ]
    `);
  });

  test("maps severity warning correctly", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "govet",
          Text: "some warning",
          Severity: "warning",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.severity).toBe("warning");
  });

  test("maps severity error correctly", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "errcheck",
          Text: "some error",
          Severity: "error",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.severity).toBe("error");
  });

  test("defaults to error when severity is missing", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "staticcheck",
          Text: "no severity specified",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.severity).toBe("error");
  });

  test("extracts ruleId from FromLinter", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "gosimple",
          Text: "simplification available",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.ruleId).toBe("gosimple");
  });

  test("sets column to undefined when Column is 0", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "deadcode",
          Text: "unused",
          Pos: { Filename: "test.go", Line: 5, Column: 0 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.column).toBeUndefined();
  });

  test("sets column when Column is greater than 0", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "govet",
          Text: "issue",
          Pos: { Filename: "test.go", Line: 5, Column: 10 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.column).toBe(10);
  });

  test("sets fixable to true when Replacement with NewLines is present", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "gofmt",
          Text: "not formatted",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
          Replacement: { NewLines: ["fixed line"] },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.fixable).toBe(true);
  });

  test("sets fixable to true when Replacement with NeedOnlyDelete is present", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "deadcode",
          Text: "unused code",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
          Replacement: { NeedOnlyDelete: true },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.fixable).toBe(true);
  });

  test("sets fixable to true when SuggestedFixes array has items", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "govet",
          Text: "issue with fix",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
          SuggestedFixes: [{ Message: "Fix available" }],
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.fixable).toBe(true);
  });

  test("sets fixable to false when no fix information is present", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "staticcheck",
          Text: "no fix",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.fixable).toBe(false);
  });

  test("sets fixable to false when Replacement is null", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "errcheck",
          Text: "unchecked error",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
          Replacement: null,
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.fixable).toBe(false);
  });

  test("sets fixable to false when SuggestedFixes is empty array", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "ineffassign",
          Text: "ineffective assignment",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
          SuggestedFixes: [],
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.fixable).toBe(false);
  });

  test("extracts suggestion from Replacement.NewLines", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "gofmt",
          Text: "not formatted",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
          Replacement: { NewLines: ["line1", "line2"] },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.suggestions).toEqual(["Replace with: line1\nline2"]);
  });

  test("extracts suggestion from Replacement.NeedOnlyDelete", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "deadcode",
          Text: "unused",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
          Replacement: { NeedOnlyDelete: true },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.suggestions).toEqual(["Delete this code"]);
  });

  test("extracts suggestions from SuggestedFixes messages", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "revive",
          Text: "needs comment",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
          SuggestedFixes: [
            { Message: "Add documentation" },
            { Message: "Make unexported" },
          ],
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.suggestions).toEqual([
      "Add documentation",
      "Make unexported",
    ]);
  });

  test("returns undefined for suggestions when none available", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "staticcheck",
          Text: "no suggestion",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.suggestions).toBeUndefined();
  });

  test("returns undefined for suggestions when SuggestedFixes has no messages", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "govet",
          Text: "issue",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
          SuggestedFixes: [{ TextEdits: [] }],
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.suggestions).toBeUndefined();
  });

  test("converts SourceLines to stackTrace", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "govet",
          Text: "issue",
          SourceLines: ["line 1", "line 2", "line 3"],
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.stackTrace).toBe("line 1\nline 2\nline 3");
  });

  test("does not set stackTrace when SourceLines is empty", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "staticcheck",
          Text: "issue",
          SourceLines: [],
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.stackTrace).toBeUndefined();
  });

  test("does not set stackTrace when SourceLines is missing", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "staticcheck",
          Text: "issue",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result[0]?.stackTrace).toBeUndefined();
  });

  test("skips issues without Pos.Filename", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "govet",
          Text: "valid issue",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
        {
          FromLinter: "broken",
          Text: "missing filename",
          Pos: { Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe("valid issue");
  });

  test("skips issues without Text", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "govet",
          Text: "valid issue",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
        {
          FromLinter: "broken",
          Pos: { Filename: "test.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe("valid issue");
  });

  test("returns empty array for invalid JSON", () => {
    const result = parseGolangci("not valid json");
    expect(result).toEqual([]);
  });

  test("returns empty array when Issues is not an array", () => {
    const result = parseGolangci(JSON.stringify({ Issues: "not an array" }));
    expect(result).toEqual([]);
  });

  test("returns empty array when Issues is missing", () => {
    const result = parseGolangci(JSON.stringify({ Report: {} }));
    expect(result).toEqual([]);
  });

  test("returns empty array for empty input", () => {
    const result = parseGolangci("");
    expect(result).toEqual([]);
  });

  test("handles multiple issues from same file", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "errcheck",
          Text: "error 1",
          Pos: { Filename: "pkg/main.go", Line: 10, Column: 5 },
        },
        {
          FromLinter: "govet",
          Text: "error 2",
          Pos: { Filename: "pkg/main.go", Line: 20, Column: 10 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.filePath)).toEqual([
      "pkg/main.go",
      "pkg/main.go",
    ]);
    expect(result.map((d) => d.line)).toEqual([10, 20]);
  });

  test("handles issues from multiple files", () => {
    const input = JSON.stringify({
      Issues: [
        {
          FromLinter: "errcheck",
          Text: "error in file1",
          Pos: { Filename: "pkg/file1.go", Line: 1, Column: 1 },
        },
        {
          FromLinter: "govet",
          Text: "error in file2",
          Pos: { Filename: "pkg/file2.go", Line: 1, Column: 1 },
        },
        {
          FromLinter: "staticcheck",
          Text: "error in file3",
          Pos: { Filename: "internal/file3.go", Line: 1, Column: 1 },
        },
      ],
    });
    const result = parseGolangci(input);
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.filePath)).toEqual([
      "pkg/file1.go",
      "pkg/file2.go",
      "internal/file3.go",
    ]);
  });

  describe("security", () => {
    test("handles path traversal in Filename", () => {
      const input = JSON.stringify({
        Issues: [
          {
            FromLinter: "govet",
            Text: "issue",
            Pos: { Filename: "../../../etc/passwd", Line: 1, Column: 1 },
          },
        ],
      });
      const result = parseGolangci(input);
      expect(result[0]?.filePath).toBe("../../../etc/passwd");
    });

    test("handles null bytes in Filename", () => {
      const input = JSON.stringify({
        Issues: [
          {
            FromLinter: "govet",
            Text: "issue",
            Pos: { Filename: "pkg/main\x00.go", Line: 1, Column: 1 },
          },
        ],
      });
      const result = parseGolangci(input);
      expect(result[0]?.filePath).toBe("pkg/main\x00.go");
    });

    test("handles __proto__ pollution attempt", () => {
      const malicious =
        '{"__proto__": {"polluted": true}, "Issues": [{"FromLinter": "govet", "Text": "issue", "Pos": {"Filename": "test.go", "Line": 1, "Column": 1}}]}';
      const result = parseGolangci(malicious);
      expect(result).toHaveLength(1);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test("handles very long Text strings", () => {
      const longText = "x".repeat(100_000);
      const input = JSON.stringify({
        Issues: [
          {
            FromLinter: "govet",
            Text: longText,
            Pos: { Filename: "test.go", Line: 1, Column: 1 },
          },
        ],
      });
      const result = parseGolangci(input);
      expect(result[0]?.message).toBe(longText);
    });

    test("handles many issues without memory issues", () => {
      const issues = new Array(1000).fill(null).map((_, i) => ({
        FromLinter: "govet",
        Text: `issue ${i}`,
        Pos: { Filename: `pkg/file${i}.go`, Line: i + 1, Column: 1 },
      }));
      const input = JSON.stringify({ Issues: issues });
      const result = parseGolangci(input);
      expect(result).toHaveLength(1000);
    });

    test("handles deeply nested SuggestedFixes", () => {
      const input = JSON.stringify({
        Issues: [
          {
            FromLinter: "govet",
            Text: "issue",
            Pos: { Filename: "test.go", Line: 1, Column: 1 },
            SuggestedFixes: new Array(100).fill(null).map((_, i) => ({
              Message: `Fix ${i}`,
              TextEdits: [{ Pos: i, End: i + 1, NewText: "x" }],
            })),
          },
        ],
      });
      const result = parseGolangci(input);
      expect(result).toHaveLength(1);
      expect(result[0]?.suggestions?.length).toBe(100);
    });

    test("handles very long SourceLines", () => {
      const longLine = "x".repeat(10_000);
      const input = JSON.stringify({
        Issues: [
          {
            FromLinter: "govet",
            Text: "issue",
            SourceLines: [longLine, longLine, longLine],
            Pos: { Filename: "test.go", Line: 1, Column: 1 },
          },
        ],
      });
      const result = parseGolangci(input);
      expect(result[0]?.stackTrace?.length).toBe(30_002);
    });
  });
});
