import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandApprovalDecision, ToolContext } from "./context.js";
import { runCommandTool } from "./run-command.js";

// Mock executeCommand at module level
const mockExecuteCommand = vi.fn();

vi.mock("./execute.js", () => ({
  executeCommand: mockExecuteCommand,
}));

const createContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  worktreePath: tmpdir(),
  repoRoot: tmpdir(),
  runId: "test-run",
  approvedCommands: new Set(),
  deniedCommands: new Set(),
  ...overrides,
});

describe("run_command", () => {
  beforeEach(() => {
    mockExecuteCommand.mockResolvedValue({
      content: "$ mocked command\n(completed in 0ms)\n\n",
      isError: false,
      metadata: { exitCode: 0, timedOut: false },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("safe command whitelist - SAFE_COMMANDS", () => {
    describe("go commands", () => {
      test.each([
        ["go build ./...", ["go", "build", "./..."]],
        ["go test ./...", ["go", "test", "./..."]],
        ["go fmt ./...", ["go", "fmt", "./..."]],
        ["go vet ./...", ["go", "vet", "./..."]],
        ["go mod tidy", ["go", "mod", "tidy"]],
        ["go generate ./...", ["go", "generate", "./..."]],
        ["go install ./cmd/...", ["go", "install", "./cmd/..."]],
        ["go run main.go", ["go", "run", "main.go"]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects go with unknown subcommand", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "go unknown-cmd",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("go tools", () => {
      test.each([
        ["golangci-lint run", ["golangci-lint", "run"]],
        ["gofumpt -w .", ["gofumpt", "-w", "."]],
        ["goimports -w .", ["goimports", "-w", "."]],
        ["staticcheck ./...", ["staticcheck", "./..."]],
        ["govulncheck ./...", ["govulncheck", "./..."]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects golangci-lint with unknown subcommand", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "golangci-lint unknown",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("npm commands", () => {
      test.each([
        ["npm install", ["npm", "install"]],
        ["npm ci", ["npm", "ci"]],
        ["npm test", ["npm", "test"]],
        ["npm run build", ["npm", "run", "build"]],
        ["npm run lint", ["npm", "run", "lint"]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects npm with unknown subcommand", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "npm publish",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("yarn commands", () => {
      test.each([
        ["yarn install", ["yarn", "install"]],
        ["yarn test", ["yarn", "test"]],
        ["yarn run build", ["yarn", "run", "build"]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects yarn with unknown subcommand", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "yarn publish",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("pnpm commands", () => {
      test.each([
        ["pnpm install", ["pnpm", "install"]],
        ["pnpm test", ["pnpm", "test"]],
        ["pnpm run build", ["pnpm", "run", "build"]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects pnpm with unknown subcommand", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "pnpm publish",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("bun commands", () => {
      test.each([
        ["bun install", ["bun", "install"]],
        ["bun test", ["bun", "test"]],
        ["bun run build", ["bun", "run", "build"]],
        ["bun x vitest", ["bun", "x", "vitest"]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects bun with unknown subcommand", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "bun publish",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("cargo commands", () => {
      test.each([
        ["cargo build", ["cargo", "build"]],
        ["cargo test", ["cargo", "test"]],
        ["cargo check", ["cargo", "check"]],
        ["cargo fmt", ["cargo", "fmt"]],
        ["cargo clippy", ["cargo", "clippy"]],
        ["cargo run", ["cargo", "run"]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("allows rustfmt", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "rustfmt --check src/main.rs",
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalled();
      });

      test("rejects cargo with unknown subcommand", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "cargo publish",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("python commands", () => {
      test.each([
        ["python -m pytest", ["python", "-m", "pytest"]],
        ["python3 -m mypy", ["python3", "-m", "mypy"]],
        [
          "pip install -r requirements.txt",
          ["pip", "install", "-r", "requirements.txt"],
        ],
        ["pip3 install package", ["pip3", "install", "package"]],
        ["pytest", ["pytest"]],
        ["mypy .", ["mypy", "."]],
        ["ruff check .", ["ruff", "check", "."]],
        ["ruff format .", ["ruff", "format", "."]],
        ["black .", ["black", "."]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects python without -m flag", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "python script.py",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects ruff with unknown subcommand", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "ruff unknown",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("linter commands", () => {
      test.each([
        ["eslint .", ["eslint", "."]],
        ["prettier --check .", ["prettier", "--check", "."]],
        ["tsc --noEmit", ["tsc", "--noEmit"]],
        ["biome check .", ["biome", "check", "."]],
        ["biome format .", ["biome", "format", "."]],
        ["biome lint .", ["biome", "lint", "."]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects biome with unknown subcommand", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "biome unknown",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("path extraction for base commands", () => {
      test("allows commands with absolute paths", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "/usr/bin/go build ./...",
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalled();
      });

      test("allows commands with relative paths", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "./node_modules/.bin/eslint .",
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalled();
      });
    });
  });

  describe("safe command whitelist - SAFE_NPX_COMMANDS", () => {
    describe("npx with allowed packages", () => {
      test.each([
        ["npx eslint .", ["npx", "eslint", "."]],
        ["npx prettier --check .", ["npx", "prettier", "--check", "."]],
        ["npx biome check .", ["npx", "biome", "check", "."]],
        ["npx oxlint .", ["npx", "oxlint", "."]],
        ["npx tsc --noEmit", ["npx", "tsc", "--noEmit"]],
        ["npx tsc-watch", ["npx", "tsc-watch"]],
        ["npx vitest run", ["npx", "vitest", "run"]],
        ["npx jest", ["npx", "jest"]],
        ["npx turbo run build", ["npx", "turbo", "run", "build"]],
        ["npx nx run build", ["npx", "nx", "run", "build"]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects npx with unknown package", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "npx unknown-package",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects npx with potentially dangerous package", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "npx rimraf node_modules",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("bunx with allowed packages", () => {
      test.each([
        ["bunx eslint .", ["bunx", "eslint", "."]],
        ["bunx prettier --check .", ["bunx", "prettier", "--check", "."]],
        ["bunx biome check .", ["bunx", "biome", "check", "."]],
        ["bunx oxlint .", ["bunx", "oxlint", "."]],
        ["bunx tsc --noEmit", ["bunx", "tsc", "--noEmit"]],
        ["bunx tsc-watch", ["bunx", "tsc-watch"]],
        ["bunx vitest run", ["bunx", "vitest", "run"]],
        ["bunx jest", ["bunx", "jest"]],
        ["bunx turbo run build", ["bunx", "turbo", "run", "build"]],
        ["bunx nx run build", ["bunx", "nx", "run", "build"]],
      ])("allows: %s", async (command, expectedParts) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });
        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalledWith(
          expect.any(String),
          command,
          expectedParts
        );
      });

      test("rejects bunx with unknown package", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "bunx unknown-package",
        });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });
  });

  describe("approval flow - decision priority", () => {
    test("priority 1: safe command bypasses all other checks", async () => {
      const commandChecker = vi.fn().mockReturnValue(false);
      const commandApprover = vi.fn().mockResolvedValue("deny");

      const ctx = createContext({
        commandChecker,
        commandApprover,
        deniedCommands: new Set(["go test ./..."]),
      });

      const result = await runCommandTool.execute(ctx, {
        command: "go test ./...",
      });

      expect(result.isError).toBe(false);
      expect(commandChecker).not.toHaveBeenCalled();
      expect(commandApprover).not.toHaveBeenCalled();
      expect(mockExecuteCommand).toHaveBeenCalled();
    });

    test("priority 2: commandChecker allows before checking sets", async () => {
      const commandChecker = vi.fn().mockReturnValue(true);
      const commandApprover = vi.fn().mockResolvedValue("deny");

      const ctx = createContext({
        commandChecker,
        commandApprover,
        deniedCommands: new Set(["make build"]),
      });

      const result = await runCommandTool.execute(ctx, {
        command: "make build",
      });

      expect(result.isError).toBe(false);
      expect(commandChecker).toHaveBeenCalledWith("make build");
      expect(commandApprover).not.toHaveBeenCalled();
      expect(mockExecuteCommand).toHaveBeenCalled();
    });

    test("priority 3: approvedCommands allows before checking deniedCommands", async () => {
      const commandApprover = vi.fn().mockResolvedValue("deny");

      const ctx = createContext({
        commandApprover,
        approvedCommands: new Set(["make build"]),
        deniedCommands: new Set(["make build"]),
      });

      const result = await runCommandTool.execute(ctx, {
        command: "make build",
      });

      expect(result.isError).toBe(false);
      expect(commandApprover).not.toHaveBeenCalled();
      expect(mockExecuteCommand).toHaveBeenCalled();
    });

    test("priority 4: deniedCommands rejects before asking user", async () => {
      const commandApprover = vi.fn().mockResolvedValue("allow");

      const ctx = createContext({
        commandApprover,
        deniedCommands: new Set(["make build"]),
      });

      const result = await runCommandTool.execute(ctx, {
        command: "make build",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("command not approved");
      expect(commandApprover).not.toHaveBeenCalled();
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    test("priority 5: commandApprover is called when all else fails", async () => {
      const commandApprover = vi.fn().mockResolvedValue("allow");

      const ctx = createContext({
        commandApprover,
      });

      const result = await runCommandTool.execute(ctx, {
        command: "make build",
      });

      expect(result.isError).toBe(false);
      expect(commandApprover).toHaveBeenCalledWith("make build");
      expect(mockExecuteCommand).toHaveBeenCalled();
    });

    test("rejects when no commandApprover and command not in safe list", async () => {
      const ctx = createContext();

      const result = await runCommandTool.execute(ctx, {
        command: "make build",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("command not approved");
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    test("commandChecker returning false continues to next check", async () => {
      const commandChecker = vi.fn().mockReturnValue(false);
      const commandApprover = vi.fn().mockResolvedValue("allow");

      const ctx = createContext({
        commandChecker,
        commandApprover,
      });

      const result = await runCommandTool.execute(ctx, {
        command: "make build",
      });

      expect(result.isError).toBe(false);
      expect(commandChecker).toHaveBeenCalledWith("make build");
      expect(commandApprover).toHaveBeenCalledWith("make build");
      expect(mockExecuteCommand).toHaveBeenCalled();
    });
  });

  describe("decision handling", () => {
    describe("allow decision", () => {
      test("allows command execution", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("allow" as CommandApprovalDecision);

        const ctx = createContext({ commandApprover });
        const result = await runCommandTool.execute(ctx, {
          command: "make build",
        });

        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalled();
      });

      test("adds command to approvedCommands set", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("allow" as CommandApprovalDecision);

        const ctx = createContext({ commandApprover });
        await runCommandTool.execute(ctx, { command: "make build" });

        expect(ctx.approvedCommands.has("make build")).toBe(true);
      });

      test("does not call commandPersister", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("allow" as CommandApprovalDecision);
        const commandPersister = vi.fn().mockResolvedValue(undefined);

        const ctx = createContext({ commandApprover, commandPersister });
        await runCommandTool.execute(ctx, { command: "make build" });

        expect(commandPersister).not.toHaveBeenCalled();
      });
    });

    describe("deny decision", () => {
      test("rejects command execution", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("deny" as CommandApprovalDecision);

        const ctx = createContext({ commandApprover });
        const result = await runCommandTool.execute(ctx, {
          command: "make build",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("adds command to deniedCommands set", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("deny" as CommandApprovalDecision);

        const ctx = createContext({ commandApprover });
        await runCommandTool.execute(ctx, { command: "make build" });

        expect(ctx.deniedCommands.has("make build")).toBe(true);
      });
    });

    describe("always decision", () => {
      test("allows command execution", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("always" as CommandApprovalDecision);

        const ctx = createContext({ commandApprover });
        const result = await runCommandTool.execute(ctx, {
          command: "make build",
        });

        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalled();
      });

      test("adds command to approvedCommands set", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("always" as CommandApprovalDecision);

        const ctx = createContext({ commandApprover });
        await runCommandTool.execute(ctx, { command: "make build" });

        expect(ctx.approvedCommands.has("make build")).toBe(true);
      });

      test("calls commandPersister to save the command", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("always" as CommandApprovalDecision);
        const commandPersister = vi.fn().mockResolvedValue(undefined);

        const ctx = createContext({ commandApprover, commandPersister });
        await runCommandTool.execute(ctx, { command: "make build" });

        expect(commandPersister).toHaveBeenCalledWith("make build");
      });

      test("does not call commandPersister if not provided", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("always" as CommandApprovalDecision);

        const ctx = createContext({ commandApprover });
        const result = await runCommandTool.execute(ctx, {
          command: "make build",
        });

        expect(result.isError).toBe(false);
        expect(mockExecuteCommand).toHaveBeenCalled();
      });
    });

    describe("never decision", () => {
      test("rejects command execution", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("never" as CommandApprovalDecision);

        const ctx = createContext({ commandApprover });
        const result = await runCommandTool.execute(ctx, {
          command: "make build",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toContain("command not approved");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("adds command to deniedCommands set", async () => {
        const commandApprover = vi
          .fn()
          .mockResolvedValue("never" as CommandApprovalDecision);

        const ctx = createContext({ commandApprover });
        await runCommandTool.execute(ctx, { command: "make build" });

        expect(ctx.deniedCommands.has("make build")).toBe(true);
      });
    });
  });

  describe("commandPersister", () => {
    test("called with correct command on always decision", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("always" as CommandApprovalDecision);
      const commandPersister = vi.fn().mockResolvedValue(undefined);

      const ctx = createContext({ commandApprover, commandPersister });
      await runCommandTool.execute(ctx, { command: "make build" });

      expect(commandPersister).toHaveBeenCalledTimes(1);
      expect(commandPersister).toHaveBeenCalledWith("make build");
    });

    test("handles errors gracefully", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("always" as CommandApprovalDecision);
      const commandPersister = vi
        .fn()
        .mockRejectedValue(new Error("Failed to save"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
        // Suppress error logging in tests
      });

      const ctx = createContext({ commandApprover, commandPersister });
      const result = await runCommandTool.execute(ctx, {
        command: "make build",
      });

      // Command should still execute even if persister fails
      expect(result.isError).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        "warning: failed to save command:",
        expect.any(Error)
      );
      expect(mockExecuteCommand).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    test("adds to approvedCommands even if persister fails", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("always" as CommandApprovalDecision);
      const commandPersister = vi
        .fn()
        .mockRejectedValue(new Error("Failed to save"));
      vi.spyOn(console, "error").mockImplementation(() => {
        // Suppress error logging in tests
      });

      const ctx = createContext({ commandApprover, commandPersister });
      await runCommandTool.execute(ctx, { command: "make build" });

      expect(ctx.approvedCommands.has("make build")).toBe(true);
    });

    test("not called on allow decision", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("allow" as CommandApprovalDecision);
      const commandPersister = vi.fn().mockResolvedValue(undefined);

      const ctx = createContext({ commandApprover, commandPersister });
      await runCommandTool.execute(ctx, { command: "make build" });

      expect(commandPersister).not.toHaveBeenCalled();
    });

    test("not called on deny decision", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("deny" as CommandApprovalDecision);
      const commandPersister = vi.fn().mockResolvedValue(undefined);

      const ctx = createContext({ commandApprover, commandPersister });
      await runCommandTool.execute(ctx, { command: "make build" });

      expect(commandPersister).not.toHaveBeenCalled();
    });

    test("not called on never decision", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("never" as CommandApprovalDecision);
      const commandPersister = vi.fn().mockResolvedValue(undefined);

      const ctx = createContext({ commandApprover, commandPersister });
      await runCommandTool.execute(ctx, { command: "make build" });

      expect(commandPersister).not.toHaveBeenCalled();
    });
  });

  describe("input validation", () => {
    describe("empty command", () => {
      test("rejects empty string", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe("command is required");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects undefined command", async () => {
        const result = await runCommandTool.execute(createContext(), {});

        expect(result.isError).toBe(true);
        expect(result.content).toBe("command is required");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects whitespace-only command", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "   ",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe("empty command");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects tabs-only command", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "\t\t\t",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe("empty command");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("blocked bytes", () => {
      test("rejects null byte", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "echo\x00hello",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe("command contains invalid characters");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects newline", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "echo\nhello",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe("command contains invalid characters");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects carriage return", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "echo\rhello",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe("command contains invalid characters");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects CRLF", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "echo\r\nhello",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe("command contains invalid characters");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects blocked byte at start", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "\x00echo hello",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe("command contains invalid characters");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects blocked byte at end", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "echo hello\x00",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe("command contains invalid characters");
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("blocked patterns", () => {
      test.each([
        ["rm -rf /", "rm -rf"],
        ["rm -r folder", "rm -r"],
        ["sudo apt install", "sudo"],
        ["chmod 755 file", "chmod"],
        ["chown user file", "chown"],
        ["curl http://example.com", "curl"],
        ["wget http://example.com", "wget"],
        ["git push origin main", "git push"],
        ["git remote add", "git remote"],
        ["git config user.name", "git config"],
        ["ssh user@host", "ssh"],
        ["scp file user@host:", "scp"],
        ["nc -l 8080", "nc "],
        ["netcat server", "netcat"],
        ["echo > /etc/passwd", "> /"],
        ["echo >> file", ">>"],
        ["ls | grep foo", "|"],
        ["cmd1 && cmd2", "&&"],
        ["cmd1; cmd2", ";"],
        ["echo $(whoami)", "$("],
        ["echo `whoami`", "`"],
        ["eval $cmd", "eval"],
        ["exec /bin/sh", "exec"],
        // Note: ${PATH} pattern - use string concatenation to avoid lint error
      ])("rejects command with pattern %s -> %s", async (command, pattern) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe(`blocked pattern: "${pattern}"`);
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects command with dollar brace pattern", async () => {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing blocked pattern
        const command = "echo ${PATH}";
        const result = await runCommandTool.execute(createContext(), {
          command,
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe('blocked pattern: "${"');
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("|| pattern is caught by | pattern first", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "cmd1 || cmd2",
        });

        expect(result.isError).toBe(true);
        // | is checked before || in BLOCKED_PATTERNS
        expect(result.content).toBe('blocked pattern: "|"');
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });

    describe("blocked commands", () => {
      test.each([
        ["sh", "sh"],
        ["bash", "bash"],
        ["zsh", "zsh"],
        ["fish", "fish"],
        ["dash", "dash"],
        ["/bin/sh -c test", "sh"],
        ["/bin/bash -c test", "bash"],
        ["/bin/zsh -c test", "zsh"],
        ["/usr/bin/fish -c test", "fish"],
        ["/bin/dash -c test", "dash"],
      ])("rejects blocked base command: %s", async (command, expectedCommand) => {
        const result = await runCommandTool.execute(createContext(), {
          command,
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe(`blocked command: "${expectedCommand}"`);
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects blocked command with path prefix", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "/usr/bin/rm file.txt",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe('blocked command: "rm"');
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });

      test("rejects blocked command with relative path", async () => {
        const result = await runCommandTool.execute(createContext(), {
          command: "./scripts/rm file.txt",
        });

        expect(result.isError).toBe(true);
        expect(result.content).toBe('blocked command: "rm"');
        expect(mockExecuteCommand).not.toHaveBeenCalled();
      });
    });
  });

  describe("session state persistence", () => {
    test("subsequent calls use approvedCommands set", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("allow" as CommandApprovalDecision);

      const ctx = createContext({ commandApprover });

      // First call - should ask approver
      await runCommandTool.execute(ctx, { command: "make build" });
      expect(commandApprover).toHaveBeenCalledTimes(1);

      // Second call - should use approvedCommands set
      await runCommandTool.execute(ctx, { command: "make build" });
      expect(commandApprover).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    test("subsequent calls use deniedCommands set", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("deny" as CommandApprovalDecision);

      const ctx = createContext({ commandApprover });

      // First call - should ask approver
      await runCommandTool.execute(ctx, { command: "make build" });
      expect(commandApprover).toHaveBeenCalledTimes(1);

      // Second call - should use deniedCommands set
      await runCommandTool.execute(ctx, { command: "make build" });
      expect(commandApprover).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    test("different commands are tracked separately", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("allow" as CommandApprovalDecision);

      const ctx = createContext({ commandApprover });

      await runCommandTool.execute(ctx, { command: "make build" });
      await runCommandTool.execute(ctx, { command: "make test" });

      expect(commandApprover).toHaveBeenCalledTimes(2);
      expect(ctx.approvedCommands.has("make build")).toBe(true);
      expect(ctx.approvedCommands.has("make test")).toBe(true);
    });
  });

  describe("whitespace normalization", () => {
    test("normalizes multiple spaces", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("allow" as CommandApprovalDecision);

      const ctx = createContext({ commandApprover });
      await runCommandTool.execute(ctx, { command: "make    build" });

      expect(commandApprover).toHaveBeenCalledWith("make build");
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.any(String),
        "make build",
        ["make", "build"]
      );
    });

    test("normalizes tabs", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("allow" as CommandApprovalDecision);

      const ctx = createContext({ commandApprover });
      await runCommandTool.execute(ctx, { command: "make\tbuild" });

      expect(commandApprover).toHaveBeenCalledWith("make build");
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.any(String),
        "make build",
        ["make", "build"]
      );
    });

    test("normalizes mixed whitespace", async () => {
      const commandApprover = vi
        .fn()
        .mockResolvedValue("allow" as CommandApprovalDecision);

      const ctx = createContext({ commandApprover });
      await runCommandTool.execute(ctx, { command: "make  \t  build" });

      expect(commandApprover).toHaveBeenCalledWith("make build");
    });

    test("handles leading and trailing whitespace", async () => {
      // normalizeCommand splits on whitespace and joins with single space
      // This preserves leading/trailing spaces in the normalized form
      const result = await runCommandTool.execute(createContext(), {
        command: "  go test ./...  ",
      });

      expect(result.isError).toBe(false);
      // The normalization results in " go test ./... " with leading/trailing spaces
      // but split().filter(Boolean) removes empty strings from the parts array
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        expect.any(String),
        " go test ./... ",
        ["go", "test", "./..."]
      );
    });
  });

  describe("edge cases", () => {
    test("command with many arguments is allowed if safe", async () => {
      const result = await runCommandTool.execute(createContext(), {
        command: "go test -v -race -cover -timeout 5m ./...",
      });

      expect(result.isError).toBe(false);
      expect(mockExecuteCommand).toHaveBeenCalled();
    });

    test("safe command with no subcommand is rejected", async () => {
      const result = await runCommandTool.execute(createContext(), {
        command: "go",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("command not approved");
    });

    test("npx without package name is rejected", async () => {
      const result = await runCommandTool.execute(createContext(), {
        command: "npx",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("command not approved");
    });

    test("bunx without package name is rejected", async () => {
      const result = await runCommandTool.execute(createContext(), {
        command: "bunx",
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain("command not approved");
    });
  });
});
