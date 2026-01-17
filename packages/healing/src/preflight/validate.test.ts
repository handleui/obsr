import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractedError } from "@detent/types";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { validateErrors } from "./validate.js";

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "healing-validate-"));
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

const makeError = (
  overrides: Partial<ExtractedError> = {}
): ExtractedError => ({
  message: "test error",
  category: "unknown",
  ...overrides,
});

describe("validateErrors", () => {
  test("errors without file paths pass through as valid", () => {
    const errors = [
      makeError({ message: "no file" }),
      makeError({ message: "also no file", filePath: undefined }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(2);
    expect(result.stale).toHaveLength(0);
  });

  test("missing files marked as stale", () => {
    const errors = [makeError({ filePath: "does-not-exist.ts", line: 1 })];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(0);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]?.reason).toBe("file_missing");
  });

  test("path traversal attempts marked as stale", () => {
    const errors = [
      makeError({ filePath: "../../../etc/passwd", line: 1 }),
      makeError({ filePath: "foo/../../bar/../../../secret", line: 1 }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(0);
    expect(result.stale).toHaveLength(2);
    for (const stale of result.stale) {
      expect(stale.reason).toBe("file_missing");
    }
  });

  test("line out of bounds detected", async () => {
    await writeFile(join(repoRoot, "short.ts"), "line1\nline2\n");

    const errors = [makeError({ filePath: "short.ts", line: 10 })];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(0);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]?.reason).toBe("line_out_of_bounds");
  });

  test("matching code snippet passes validation", async () => {
    await writeFile(join(repoRoot, "code.ts"), "const x = 1;\nconst y = 2;\n");

    const errors = [
      makeError({
        filePath: "code.ts",
        line: 1,
        codeSnippet: {
          lines: ["const x = 1;"],
          startLine: 1,
          errorLine: 1,
          language: "typescript",
        },
      }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(1);
    expect(result.stale).toHaveLength(0);
  });

  test("changed code snippet marked as stale", async () => {
    await writeFile(
      join(repoRoot, "code.ts"),
      "const x = 999;\nconst y = 2;\n"
    );

    const errors = [
      makeError({
        filePath: "code.ts",
        line: 1,
        codeSnippet: {
          lines: ["const x = 1;"],
          startLine: 1,
          errorLine: 1,
          language: "typescript",
        },
      }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(0);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]?.reason).toBe("code_changed");
  });

  test("empty code snippets treated as valid", async () => {
    await writeFile(join(repoRoot, "code.ts"), "const x = 1;\n");

    const errors = [
      makeError({
        filePath: "code.ts",
        line: 1,
        codeSnippet: {
          lines: [],
          startLine: 1,
          errorLine: 1,
          language: "typescript",
        },
      }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(1);
    expect(result.stale).toHaveLength(0);
  });

  test("undefined codeSnippet treated as valid", async () => {
    await writeFile(join(repoRoot, "code.ts"), "const x = 1;\n");

    const errors = [
      makeError({
        filePath: "code.ts",
        line: 1,
        codeSnippet: undefined,
      }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(1);
    expect(result.stale).toHaveLength(0);
  });

  test("errors with lineKnown=false pass through as valid", async () => {
    await writeFile(join(repoRoot, "code.ts"), "const x = 1;\n");

    const errors = [
      makeError({
        filePath: "code.ts",
        line: 999,
        lineKnown: false,
      }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(1);
    expect(result.stale).toHaveLength(0);
  });

  test("handles nested file paths", async () => {
    await mkdir(join(repoRoot, "src", "utils"), { recursive: true });
    await writeFile(
      join(repoRoot, "src", "utils", "helpers.ts"),
      "export const foo = 1;\n"
    );

    const errors = [
      makeError({
        filePath: "src/utils/helpers.ts",
        line: 1,
        codeSnippet: {
          lines: ["export const foo = 1;"],
          startLine: 1,
          errorLine: 1,
          language: "typescript",
        },
      }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(1);
    expect(result.stale).toHaveLength(0);
  });

  test("whitespace normalization in code comparison", async () => {
    await writeFile(join(repoRoot, "code.ts"), "const   x   =   1;\n");

    const errors = [
      makeError({
        filePath: "code.ts",
        line: 1,
        codeSnippet: {
          lines: ["const x = 1;"],
          startLine: 1,
          errorLine: 1,
          language: "typescript",
        },
      }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(1);
    expect(result.stale).toHaveLength(0);
  });

  test("multiple errors in same file grouped efficiently", async () => {
    await writeFile(join(repoRoot, "code.ts"), "line1\nline2\nline3\n");

    const errors = [
      makeError({ filePath: "code.ts", line: 1 }),
      makeError({ filePath: "code.ts", line: 2 }),
      makeError({ filePath: "code.ts", line: 3 }),
    ];

    const result = validateErrors(errors, repoRoot);

    expect(result.valid).toHaveLength(3);
    expect(result.stale).toHaveLength(0);
  });
});
