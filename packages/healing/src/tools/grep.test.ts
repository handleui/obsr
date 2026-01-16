import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ToolContext } from "./context.js";
import { grepTool } from "./grep.js";

const createContext = (worktreePath: string): ToolContext => ({
  worktreePath,
  repoRoot: worktreePath,
  runId: "test-run",
  approvedCommands: new Set(),
  deniedCommands: new Set(),
});

const createWorktree = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "healing-grep-"));

describe("grep", () => {
  test("supports regex patterns with type filtering", async () => {
    const worktreePath = await createWorktree();
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "app.ts"), "needle-123", "utf8");
    await writeFile(join(worktreePath, "src", "app.js"), "needle-999", "utf8");

    const result = await grepTool.execute(createContext(worktreePath), {
      pattern: "needle-\\d+",
      path: "src",
      type: "ts",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("src/app.ts:1:needle-123");
    expect(result.content).not.toContain("app.js");
  });

  test("limits matches to max count", async () => {
    const worktreePath = await createWorktree();
    const lines: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      lines.push(`needle ${i}`);
    }
    await writeFile(
      join(worktreePath, "many.txt"),
      `${lines.join("\n")}\n`,
      "utf8"
    );

    const result = await grepTool.execute(createContext(worktreePath), {
      pattern: "needle",
      path: "many.txt",
    });

    expect(result.isError).toBe(false);
    const outputLines = result.content
      .split("\n")
      .filter((line) => line.length > 0);
    expect(outputLines.length).toBe(100);
  });

  test("rejects absolute paths", async () => {
    const worktreePath = await createWorktree();
    const result = await grepTool.execute(createContext(worktreePath), {
      pattern: "test",
      path: "/etc",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe("absolute paths not allowed: /etc");
  });

  test("returns message when no matches found", async () => {
    const worktreePath = await createWorktree();
    await writeFile(join(worktreePath, "test.txt"), "hello world", "utf8");

    const result = await grepTool.execute(createContext(worktreePath), {
      pattern: "nonexistent",
      path: "test.txt",
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe("no matches found for pattern: nonexistent");
  });

  test("returns error for unknown file type", async () => {
    const worktreePath = await createWorktree();
    const result = await grepTool.execute(createContext(worktreePath), {
      pattern: "test",
      type: "invalid-type",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown file type: invalid-type");
  });

  test("returns error for empty pattern", async () => {
    const worktreePath = await createWorktree();
    const result = await grepTool.execute(createContext(worktreePath), {
      pattern: "",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe("pattern is required");
  });
});
