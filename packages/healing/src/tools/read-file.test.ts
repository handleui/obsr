import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ToolContext } from "./context.js";
import { readFileTool } from "./read-file.js";

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
  const worktreePath = await mkdtemp(join(tmpdir(), "healing-read-file-"));
  const relativePath = "src/sample.txt";
  const absPath = join(worktreePath, relativePath);
  await mkdir(join(worktreePath, "src"), { recursive: true });
  await writeFile(absPath, content, "utf8");
  return { worktreePath, relativePath, absPath };
};

describe("read_file", () => {
  test("reads lines with line numbers and applies offset/limit", async () => {
    const fixture = await createWorktreeWithFile(
      "one\ntwo\nthree\nfour\nfive\n"
    );
    const result = await readFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        offset: 2,
        limit: 2,
      }
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("     2\ttwo");
    expect(result.content).toContain("     3\tthree");
    expect(result.content).toContain(
      "... (truncated at 2 lines, use offset to read more)"
    );
  });

  test("returns error when offset exceeds file length", async () => {
    const fixture = await createWorktreeWithFile("alpha\nbeta\n");
    const result = await readFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        offset: 5,
        limit: 1,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("offset 5 exceeds file length (2 lines)");
  });

  test("rejects absolute paths", async () => {
    const fixture = await createWorktreeWithFile("content");
    const result = await readFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: "/etc/passwd",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("absolute paths not allowed: /etc/passwd");
  });

  test("returns error for file not found", async () => {
    const fixture = await createWorktreeWithFile("content");
    const result = await readFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: "nonexistent.txt",
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("file not found: nonexistent.txt");
  });

  test("returns error when path is a directory", async () => {
    const worktreePath = await mkdtemp(join(tmpdir(), "healing-read-file-"));
    await mkdir(join(worktreePath, "subdir"), { recursive: true });

    const result = await readFileTool.execute(createContext(worktreePath), {
      path: "subdir",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe("path is a directory: subdir");
  });

  test("handles empty file", async () => {
    const fixture = await createWorktreeWithFile("");
    const result = await readFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
      }
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("(empty file)");
  });

  test("returns error for invalid offset", async () => {
    const fixture = await createWorktreeWithFile("content");
    const result = await readFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        offset: 0,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("offset must be at least 1");
  });

  test("returns error for invalid limit", async () => {
    const fixture = await createWorktreeWithFile("content");
    const result = await readFileTool.execute(
      createContext(fixture.worktreePath),
      {
        path: fixture.relativePath,
        limit: 0,
      }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toBe("limit must be at least 1");
  });
});
