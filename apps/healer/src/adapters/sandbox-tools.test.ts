import type { Tool } from "@detent/healing/tools";
import { describe, expect, test, vi } from "vitest";
import {
  createSandboxToolContext,
  createSandboxTools,
} from "./sandbox-tools.js";

const createMockSandbox = (
  overrides: Partial<{
    commandsRun: (
      cmd: string,
      opts?: unknown
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    filesExists: (path: string) => Promise<boolean>;
    filesRead: (path: string, opts?: unknown) => Promise<string>;
    filesWrite: (path: string, content: string) => Promise<void>;
    filesGetInfo: (path: string) => Promise<{ type: "file" | "dir" }>;
  }> = {}
) => ({
  sandboxId: "test-sandbox",
  runCode: vi.fn(),
  commands: {
    run:
      overrides.commandsRun ??
      vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  },
  files: {
    write: overrides.filesWrite ?? vi.fn().mockResolvedValue(undefined),
    read: overrides.filesRead ?? vi.fn().mockResolvedValue("file content"),
    exists: overrides.filesExists ?? vi.fn().mockResolvedValue(true),
    getInfo:
      overrides.filesGetInfo ?? vi.fn().mockResolvedValue({ type: "file" }),
  },
  kill: vi.fn(),
  setTimeout: vi.fn(),
  isRunning: vi.fn().mockResolvedValue(true),
});

const findTool = (tools: Tool[], name: string): Tool => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool "${name}" not found`);
  }
  return tool;
};

describe("sandbox path validation", () => {
  const worktreePath = "/home/user/repo";

  describe("null byte rejection", () => {
    test("rejects path containing null byte", async () => {
      const sandbox = createMockSandbox();
      const ctx = createSandboxToolContext({
        sandbox: sandbox as never,
        worktreePath,
        repoRoot: worktreePath,
        runId: "test-run",
      });
      const tools = createSandboxTools(sandbox as never);
      const readFile = findTool(tools, "read_file");
      const result = await readFile.execute(ctx, { path: "src/\0file.ts" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("null byte");
    });

    test("accepts clean paths", async () => {
      const sandbox = createMockSandbox();
      const ctx = createSandboxToolContext({
        sandbox: sandbox as never,
        worktreePath,
        repoRoot: worktreePath,
        runId: "test-run",
      });
      const tools = createSandboxTools(sandbox as never);
      const readFile = findTool(tools, "read_file");
      const result = await readFile.execute(ctx, { path: "src/file.ts" });
      expect(result.isError).toBe(false);
    });
  });

  describe("null byte in edit content", () => {
    test("rejects new_string containing null byte", async () => {
      const sandbox = createMockSandbox({
        filesRead: vi.fn().mockResolvedValue("old content"),
      });
      const ctx = createSandboxToolContext({
        sandbox: sandbox as never,
        worktreePath,
        repoRoot: worktreePath,
        runId: "test-run",
      });
      const tools = createSandboxTools(sandbox as never);
      const editFile = findTool(tools, "edit_file");
      const result = await editFile.execute(ctx, {
        path: "src/file.ts",
        old_string: "old content",
        new_string: "new\0content",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("null byte");
    });
  });

  describe("symlink traversal", () => {
    test("allows path when readlink resolves inside worktree", async () => {
      const sandbox = createMockSandbox({
        commandsRun: vi.fn().mockResolvedValue({
          stdout: "/home/user/repo/src/real-file.ts\n",
          stderr: "",
          exitCode: 0,
        }),
      });
      const ctx = createSandboxToolContext({
        sandbox: sandbox as never,
        worktreePath,
        repoRoot: worktreePath,
        runId: "test-run",
      });
      const tools = createSandboxTools(sandbox as never);
      const readFile = findTool(tools, "read_file");
      const result = await readFile.execute(ctx, { path: "src/file.ts" });
      expect(result.isError).toBe(false);
    });

    test("rejects path when readlink resolves outside worktree", async () => {
      const sandbox = createMockSandbox({
        commandsRun: vi.fn().mockResolvedValue({
          stdout: "/etc/passwd\n",
          stderr: "",
          exitCode: 0,
        }),
        filesExists: vi.fn().mockResolvedValue(true),
        filesGetInfo: vi.fn().mockResolvedValue({ type: "file" }),
      });
      const ctx = createSandboxToolContext({
        sandbox: sandbox as never,
        worktreePath,
        repoRoot: worktreePath,
        runId: "test-run",
      });
      const tools = createSandboxTools(sandbox as never);
      const readFile = findTool(tools, "read_file");
      const result = await readFile.execute(ctx, { path: "src/symlink.ts" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("symlink escapes worktree");
    });

    test("allows path when readlink fails (file does not exist yet)", async () => {
      const sandbox = createMockSandbox({
        commandsRun: vi.fn().mockResolvedValue({
          stdout: "",
          stderr: "No such file",
          exitCode: 1,
        }),
      });
      const ctx = createSandboxToolContext({
        sandbox: sandbox as never,
        worktreePath,
        repoRoot: worktreePath,
        runId: "test-run",
      });
      const tools = createSandboxTools(sandbox as never);
      const readFile = findTool(tools, "read_file");
      const result = await readFile.execute(ctx, { path: "src/file.ts" });
      expect(result.isError).toBe(false);
    });
  });
});
