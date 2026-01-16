import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ToolContext } from "./context.js";
import { validatePath } from "./context.js";

const createContext = (worktreePath: string): ToolContext => ({
  worktreePath,
  repoRoot: worktreePath,
  runId: "test-run",
  approvedCommands: new Set(),
  deniedCommands: new Set(),
});

const createWorktree = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "healing-context-"));

describe("validatePath", () => {
  test("rejects absolute paths", async () => {
    const worktreePath = await createWorktree();
    const result = validatePath(createContext(worktreePath), "/tmp/file.txt");

    expect(result.valid).toBe(false);
    expect(result.error?.content).toBe(
      "absolute paths not allowed: /tmp/file.txt"
    );
  });

  test("rejects traversal outside worktree", async () => {
    const worktreePath = await createWorktree();
    const result = validatePath(createContext(worktreePath), "../outside.txt");

    expect(result.valid).toBe(false);
    expect(result.error?.content).toBe("path escapes worktree: ../outside.txt");
  });

  test("rejects symlink escapes", async () => {
    const basePath = await createWorktree();
    const worktreePath = join(basePath, "worktree");
    const outsidePath = join(basePath, "outside");
    await mkdir(worktreePath, { recursive: true });
    await mkdir(outsidePath, { recursive: true });

    await writeFile(join(outsidePath, "secret.txt"), "secret", "utf8");
    await symlink(outsidePath, join(worktreePath, "link"));

    const result = validatePath(createContext(worktreePath), "link/secret.txt");

    expect(result.valid).toBe(false);
    expect(result.error?.content).toBe(
      "symlink escapes worktree: link/secret.txt"
    );
  });

  test("allows relative paths within worktree", async () => {
    const worktreePath = await createWorktree();
    const result = validatePath(createContext(worktreePath), "src/file.txt");

    expect(result.valid).toBe(true);
    expect(result.absPath).toBe(join(worktreePath, "src/file.txt"));
  });
});
