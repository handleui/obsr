import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ToolContext } from "./context.js";
import { editFileTool } from "./edit-file.js";

interface WorktreeFixture {
  worktreePath: string;
  relativePath: string;
  absPath: string;
}

const createContext = (worktreePath: string): ToolContext => ({
  worktreePath,
  repoRoot: worktreePath,
  runId: "test-run",
  approvedCommands: new Set(),
  deniedCommands: new Set(),
});

const createWorktreeWithFile = async (
  content: string
): Promise<WorktreeFixture> => {
  const worktreePath = await mkdtemp(join(tmpdir(), "healing-edit-file-"));
  const relativePath = "sample.txt";
  const absPath = join(worktreePath, relativePath);
  await writeFile(absPath, content, "utf8");
  return { worktreePath, relativePath, absPath };
};

describe("edit_file", () => {
  test("returns error when old_string is missing", async () => {
    const fixture = await createWorktreeWithFile("hello world");
    const result = await editFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        old_string: "missing",
        new_string: "replace",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "old_string not found in file. Use read_file to see exact content."
    );
  });

  test("returns error when old_string appears multiple times", async () => {
    const fixture = await createWorktreeWithFile("dup dup dup");
    const result = await editFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        old_string: "dup",
        new_string: "swap",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "old_string found 3 times in file (must be unique). Include more context to make it unique."
    );
  });

  test("replaces exact match and updates file", async () => {
    const fixture = await createWorktreeWithFile("alpha beta gamma");
    const result = await editFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        old_string: "beta",
        new_string: "delta",
      }
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "file updated: sample.txt (replaced 1 line(s))"
    );

    const updated = await readFile(fixture.absPath, "utf8");
    expect(updated).toBe("alpha delta gamma");
  });

  test("rejects absolute paths", async () => {
    const fixture = await createWorktreeWithFile("content");
    const result = await editFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: "/etc/passwd",
        old_string: "old",
        new_string: "new",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("absolute paths not allowed: /etc/passwd");
  });

  test("returns error for file not found", async () => {
    const fixture = await createWorktreeWithFile("content");
    const result = await editFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: "nonexistent.txt",
        old_string: "old",
        new_string: "new",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("file not found: nonexistent.txt");
  });

  test("returns error when old_string equals new_string", async () => {
    const fixture = await createWorktreeWithFile("hello world");
    const result = await editFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        old_string: "hello",
        new_string: "hello",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("old_string and new_string are identical");
  });

  test("returns error when old_string is empty", async () => {
    const fixture = await createWorktreeWithFile("hello world");
    const result = await editFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        old_string: "",
        new_string: "new",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("old_string is required");
  });

  test("reports correct line count for multi-line replacement", async () => {
    const fixture = await createWorktreeWithFile("line1\nline2\nline3");
    const result = await editFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        old_string: "line1\nline2",
        new_string: "replaced1\nreplaced2\nreplaced3",
      }
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("replaced 2 line(s) with 3 line(s) (+1)");
  });
});
