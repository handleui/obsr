import { describe, expect, test, vi } from "vitest";
import type { ToolContext } from "./context.js";
import { createToolRegistry } from "./registry.js";
import type { Tool, ToolResult } from "./types.js";

const createMockContext = (): ToolContext => ({
  worktreePath: "/test/repo",
  repoRoot: "/test/repo",
  runId: "test-run",
  approvedCommands: new Set(),
  deniedCommands: new Set(),
});

const createMockTool = (name: string, result?: Partial<ToolResult>): Tool => ({
  name,
  description: `Mock ${name}`,
  inputSchema: { type: "object", properties: {}, required: [] },
  execute: vi.fn().mockResolvedValue({
    content: "ok",
    isError: false,
    ...result,
  }),
});

describe("ToolRegistry", () => {
  describe("rate limiting", () => {
    test("allows calls within limit", async () => {
      const ctx = createMockContext();
      const registry = createToolRegistry(ctx, { test_tool: 2 });
      const tool = createMockTool("test_tool");
      registry.register(tool);

      const result1 = await registry.dispatch("test_tool", {});
      expect(result1.isError).toBe(false);

      const result2 = await registry.dispatch("test_tool", {});
      expect(result2.isError).toBe(false);
    });

    test("rejects calls exceeding limit", async () => {
      const ctx = createMockContext();
      const registry = createToolRegistry(ctx, { test_tool: 1 });
      const tool = createMockTool("test_tool");
      registry.register(tool);

      await registry.dispatch("test_tool", {});
      const result = await registry.dispatch("test_tool", {});
      expect(result.isError).toBe(true);
      expect(result.content).toContain("tool call limit");
    });

    test("allows unlimited calls for tools without limits", async () => {
      const ctx = createMockContext();
      const registry = createToolRegistry(ctx, {});
      const tool = createMockTool("unlimited_tool");
      registry.register(tool);

      for (let i = 0; i < 10; i++) {
        const result = await registry.dispatch("unlimited_tool", {});
        expect(result.isError).toBe(false);
      }
    });
  });

  describe("audit log", () => {
    test("records log entries", async () => {
      const ctx = createMockContext();
      const registry = createToolRegistry(ctx);
      const tool = createMockTool("read_file");
      registry.register(tool);

      await registry.dispatch("read_file", { path: "test.ts" });

      const log = registry.auditLog;
      expect(log).toHaveLength(1);
      expect(log[0].tool).toBe("read_file");
      expect(log[0].isError).toBe(false);
      expect(log[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(log[0].timestamp).toBeGreaterThan(0);
    });

    test("records errors in log", async () => {
      const ctx = createMockContext();
      const registry = createToolRegistry(ctx);
      const tool = createMockTool("run_command", { isError: true });
      registry.register(tool);

      await registry.dispatch("run_command", {});

      const log = registry.auditLog;
      expect(log[0].isError).toBe(true);
    });

    test("caps log at 100 entries", async () => {
      const ctx = createMockContext();
      const registry = createToolRegistry(ctx, {});
      const tool = createMockTool("read_file");
      registry.register(tool);

      for (let i = 0; i < 110; i++) {
        await registry.dispatch("read_file", {});
      }

      expect(registry.auditLog).toHaveLength(100);
    });
  });

  describe("callStats", () => {
    test("tracks call counts by tool", async () => {
      const ctx = createMockContext();
      const registry = createToolRegistry(ctx);
      const tool1 = createMockTool("read_file");
      const tool2 = createMockTool("edit_file");
      registry.register(tool1);
      registry.register(tool2);

      await registry.dispatch("read_file", {});
      await registry.dispatch("read_file", {});
      await registry.dispatch("edit_file", {});

      const stats = registry.callStats;
      expect(stats.total).toBe(3);
      expect(stats.byTool.read_file).toBe(2);
      expect(stats.byTool.edit_file).toBe(1);
    });
  });

  test("returns error for unknown tool", async () => {
    const ctx = createMockContext();
    const registry = createToolRegistry(ctx);
    const result = await registry.dispatch("nonexistent", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown tool");
  });
});
