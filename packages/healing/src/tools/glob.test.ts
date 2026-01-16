import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ToolContext } from "./context.js";
import { globTool } from "./glob.js";

const createContext = (worktreePath: string): ToolContext => ({
  worktreePath,
  repoRoot: worktreePath,
  runId: "test-run",
  approvedCommands: new Set(),
  deniedCommands: new Set(),
});

const createWorktree = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "healing-glob-"));

describe("glob", () => {
  test("matches patterns within a scoped path", async () => {
    const worktreePath = await createWorktree();
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "app.ts"), "", "utf8");
    await writeFile(join(worktreePath, "src", "util.js"), "", "utf8");
    await writeFile(join(worktreePath, "root.ts"), "", "utf8");

    const result = await globTool.execute(createContext(worktreePath), {
      pattern: "*.ts",
      path: "src",
    });

    expect(result.isError).toBe(false);
    expect(result.content.split("\n")).toEqual(["app.ts"]);
  });

  test("truncates results beyond max limit", async () => {
    const worktreePath = await createWorktree();
    await mkdir(join(worktreePath, "many"), { recursive: true });

    const writes: Promise<void>[] = [];
    for (let i = 0; i < 205; i += 1) {
      const filePath = join(worktreePath, "many", `file-${i}.txt`);
      writes.push(writeFile(filePath, "data", "utf8"));
    }
    await Promise.all(writes);

    const result = await globTool.execute(createContext(worktreePath), {
      pattern: "*.txt",
      path: "many",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      "... (showing first 200 results, refine your pattern for more specific matches)"
    );
  });

  test("rejects absolute paths", async () => {
    const worktreePath = await createWorktree();
    const result = await globTool.execute(createContext(worktreePath), {
      pattern: "*.ts",
      path: "/etc",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe("absolute paths not allowed: /etc");
  });

  test("returns message when no files match", async () => {
    const worktreePath = await createWorktree();
    await mkdir(join(worktreePath, "empty"), { recursive: true });

    const result = await globTool.execute(createContext(worktreePath), {
      pattern: "*.ts",
      path: "empty",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("no files match pattern: *.ts");
  });

  test("matches recursive patterns", async () => {
    const worktreePath = await createWorktree();
    await mkdir(join(worktreePath, "src", "nested"), { recursive: true });
    await writeFile(join(worktreePath, "src", "app.ts"), "", "utf8");
    await writeFile(join(worktreePath, "src", "nested", "util.ts"), "", "utf8");

    const result = await globTool.execute(createContext(worktreePath), {
      pattern: "**/*.ts",
      path: "src",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("app.ts");
    expect(result.content).toContain("nested/util.ts");
  });

  test("returns error when path not found", async () => {
    const worktreePath = await createWorktree();
    const result = await globTool.execute(createContext(worktreePath), {
      pattern: "*.ts",
      path: "nonexistent",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe("path not found: nonexistent");
  });
});
