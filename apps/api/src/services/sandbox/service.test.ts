import {
  DEFAULTS,
  type SandboxCodeExecution,
  type SandboxCommandExecution,
  type SandboxFileInfo,
  type SandboxHandle,
  TEMPLATES,
} from "@detent/sandbox";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { createSandboxService } from "./index";

// Mock E2B SDK - must mock the module path that @detent/sandbox imports from
vi.mock("@e2b/code-interpreter", () => {
  class MockRateLimitError extends Error {
    constructor(message = "Rate limit exceeded") {
      super(message);
      this.name = "RateLimitError";
    }
  }

  return {
    RateLimitError: MockRateLimitError,
    Sandbox: {
      create: vi.fn(),
      connect: vi.fn(),
      list: vi.fn(),
    },
  };
});

// Import from mocked module for vi.mocked() type inference
import { RateLimitError, Sandbox } from "@e2b/code-interpreter";

// Mock sandbox type with vitest Mock types for proper type inference
interface MockSandboxHandle {
  sandboxId: string;
  runCode: Mock<SandboxHandle["runCode"]>;
  commands: { run: Mock<SandboxHandle["commands"]["run"]> };
  files: {
    write: Mock<SandboxHandle["files"]["write"]>;
    read: Mock<SandboxHandle["files"]["read"]>;
    exists: Mock<(path: string) => Promise<boolean>>;
    getInfo: Mock<(path: string) => Promise<SandboxFileInfo>>;
  };
  kill: Mock<SandboxHandle["kill"]>;
  setTimeout: Mock<SandboxHandle["setTimeout"]>;
  isRunning: Mock<SandboxHandle["isRunning"]>;
}

// Type-safe mock sandbox with vitest mock methods
const createMockSandbox = (): MockSandboxHandle => ({
  sandboxId: "test-sandbox-123",
  runCode:
    vi.fn<
      (
        code: string,
        opts?: { language?: string; timeoutMs?: number }
      ) => Promise<SandboxCodeExecution>
    >(),
  commands: {
    run: vi.fn<
      (
        command: string,
        opts?: {
          cwd?: string;
          envs?: Record<string, string>;
          timeoutMs?: number;
        }
      ) => Promise<SandboxCommandExecution>
    >(),
  },
  files: {
    write: vi.fn<(path: string, content: string) => Promise<void>>(),
    read: vi.fn<
      (
        path: string,
        opts?: { format?: "text" | "binary" }
      ) => Promise<string | Uint8Array>
    >(),
    exists: vi.fn<(path: string) => Promise<boolean>>(),
    getInfo: vi.fn<(path: string) => Promise<SandboxFileInfo>>(),
  },
  kill: vi.fn<() => Promise<void>>(),
  setTimeout: vi.fn<(timeoutMs: number) => Promise<void>>(),
  isRunning: vi.fn<() => Promise<boolean>>(),
});

const mockSandbox = createMockSandbox();

// Interface for E2B SDK list response items (partial Sandbox with fields used by toSandboxInfo)
interface E2BListItem {
  sandboxId: string;
  templateId?: string | null;
  metadata?: Record<string, string> | null;
  startedAt?: Date | string | null;
}

// Interface for E2B SDK paginator response
interface E2BPaginator {
  hasNext: boolean;
  nextItems: () => Promise<E2BListItem[]>;
}

const mockSandboxCreate = vi.mocked(Sandbox.create);
const mockSandboxConnect = vi.mocked(Sandbox.connect);
const mockSandboxList = vi.mocked(Sandbox.list);

const createEnv = (apiKey = "test-api-key") =>
  ({
    SANDBOX_PROVIDER: "e2b",
    E2B_API_KEY: apiKey,
  }) as Parameters<typeof createSandboxService>[0];

beforeEach(() => {
  vi.clearAllMocks();
  // Cast to unknown first for type-safe mock assignment
  mockSandboxCreate.mockResolvedValue(mockSandbox as unknown as Sandbox);
  mockSandboxConnect.mockResolvedValue(mockSandbox as unknown as Sandbox);
});

describe("createSandboxService", () => {
  it("throws if E2B_API_KEY is missing", () => {
    expect(() => createSandboxService(createEnv(""))).toThrow(
      "E2B_API_KEY environment variable is not configured"
    );
  });

  it("creates service with valid API key", () => {
    const svc = createSandboxService(createEnv());
    expect(svc).toHaveProperty("create");
    expect(svc).toHaveProperty("connect");
    expect(svc).toHaveProperty("runCode");
    expect(svc).toHaveProperty("runCommand");
    expect(svc).toHaveProperty("writeFile");
    expect(svc).toHaveProperty("readFile");
    expect(svc).toHaveProperty("kill");
    expect(svc).toHaveProperty("setTimeout");
    expect(svc).toHaveProperty("isRunning");
    expect(svc).toHaveProperty("list");
  });
});

describe("create", () => {
  it("calls Sandbox.create with default params", async () => {
    const svc = createSandboxService(createEnv());
    const result = await svc.create();

    expect(mockSandboxCreate).toHaveBeenCalledWith(TEMPLATES.PYTHON, {
      apiKey: "test-api-key",
      timeoutMs: DEFAULTS.SANDBOX_TIMEOUT * 1000,
      metadata: undefined,
      envs: undefined,
    });
    expect(result.sandboxId).toBe(mockSandbox.sandboxId);
  });

  it("passes custom template, timeout, metadata, and envs", async () => {
    const svc = createSandboxService(createEnv());
    await svc.create({
      template: TEMPLATES.NODE,
      timeout: 600,
      metadata: { taskId: "task-123" },
      envs: { NODE_ENV: "production" },
    });

    expect(mockSandboxCreate).toHaveBeenCalledWith(TEMPLATES.NODE, {
      apiKey: "test-api-key",
      timeoutMs: 600 * 1000,
      metadata: { taskId: "task-123" },
      envs: { NODE_ENV: "production" },
    });
  });

  it("rejects invalid template", async () => {
    const svc = createSandboxService(createEnv());

    await expect(
      svc.create({ template: "malicious-template" })
    ).rejects.toThrow("Invalid template");
    expect(mockSandboxCreate).not.toHaveBeenCalled();
  });

  it("rejects timeout below minimum", async () => {
    const svc = createSandboxService(createEnv());

    await expect(svc.create({ timeout: 0 })).rejects.toThrow(
      "Timeout must be between 1 and 18000 seconds"
    );
  });

  it("rejects timeout above maximum", async () => {
    const svc = createSandboxService(createEnv());

    await expect(svc.create({ timeout: 18_001 })).rejects.toThrow(
      "Timeout must be between 1 and 18000 seconds"
    );
  });

  it("handles rate limit error specially", async () => {
    // Create the error using the mocked RateLimitError class
    const rateLimitErr = new RateLimitError("Too many requests");
    mockSandboxCreate.mockRejectedValueOnce(rateLimitErr);
    const svc = createSandboxService(createEnv());

    await expect(svc.create()).rejects.toThrow(
      "Sandbox rate limit exceeded. Please try again later."
    );
  });

  it("wraps generic SDK errors with context", async () => {
    mockSandboxCreate.mockRejectedValueOnce(new Error("Network failure"));
    const svc = createSandboxService(createEnv());

    await expect(svc.create()).rejects.toThrow(
      "Failed to create sandbox: Network failure"
    );
  });
});

describe("connect", () => {
  it("calls Sandbox.connect with valid sandbox ID", async () => {
    const svc = createSandboxService(createEnv());
    const result = await svc.connect("abc-123_xyz");

    expect(mockSandboxConnect).toHaveBeenCalledWith("abc-123_xyz", {
      apiKey: "test-api-key",
    });
    expect(result.sandboxId).toBe(mockSandbox.sandboxId);
  });

  it("validates sandbox ID format - rejects empty", async () => {
    const svc = createSandboxService(createEnv());

    await expect(svc.connect("")).rejects.toThrow("Invalid sandbox ID format");
    expect(mockSandboxConnect).not.toHaveBeenCalled();
  });

  it("validates sandbox ID format - rejects special chars", async () => {
    const svc = createSandboxService(createEnv());

    await expect(svc.connect("sandbox/../../../etc")).rejects.toThrow(
      "Invalid sandbox ID format"
    );
    expect(mockSandboxConnect).not.toHaveBeenCalled();
  });

  it("validates sandbox ID format - rejects too long", async () => {
    const svc = createSandboxService(createEnv());
    const longId = "a".repeat(65);

    await expect(svc.connect(longId)).rejects.toThrow(
      "Invalid sandbox ID format"
    );
    expect(mockSandboxConnect).not.toHaveBeenCalled();
  });

  it("wraps SDK errors with context", async () => {
    mockSandboxConnect.mockRejectedValueOnce(new Error("Sandbox not found"));
    const svc = createSandboxService(createEnv());

    await expect(svc.connect("valid-id")).rejects.toThrow(
      "Failed to connect to sandbox: Sandbox not found"
    );
  });
});

describe("runCode", () => {
  it("passes language and timeout options to SDK", async () => {
    mockSandbox.runCode.mockResolvedValueOnce({
      logs: { stdout: ["output"], stderr: [] },
      text: "result",
      error: null,
    });
    const svc = createSandboxService(createEnv());

    await svc.runCode(mockSandbox, 'print("hello")', {
      language: "python",
      timeout: 60,
    });

    expect(mockSandbox.runCode).toHaveBeenCalledWith('print("hello")', {
      language: "python",
      timeoutMs: 60 * 1000,
    });
  });

  it("uses default language (python) and timeout", async () => {
    mockSandbox.runCode.mockResolvedValueOnce({
      logs: { stdout: [], stderr: [] },
      text: null,
      error: null,
    });
    const svc = createSandboxService(createEnv());

    await svc.runCode(mockSandbox, "x = 1");

    expect(mockSandbox.runCode).toHaveBeenCalledWith("x = 1", {
      language: "python",
      timeoutMs: DEFAULTS.CODE_TIMEOUT * 1000,
    });
  });

  it("returns transformed CodeResult with logs and text", async () => {
    mockSandbox.runCode.mockResolvedValueOnce({
      logs: { stdout: ["line1", "line2"], stderr: ["warn"] },
      text: "42",
      error: null,
    });
    const svc = createSandboxService(createEnv());

    const result = await svc.runCode(mockSandbox, "1+1");

    expect(result).toEqual({
      logs: "line1\nline2\nwarn",
      text: "42",
      error: undefined,
    });
  });

  it("returns error value when execution fails", async () => {
    mockSandbox.runCode.mockResolvedValueOnce({
      logs: { stdout: [], stderr: ["Traceback..."] },
      text: null,
      error: { value: "NameError: name 'x' is not defined" },
    });
    const svc = createSandboxService(createEnv());

    const result = await svc.runCode(mockSandbox, "print(x)");

    expect(result.error).toBe("NameError: name 'x' is not defined");
  });

  it("rejects code exceeding max length", async () => {
    const svc = createSandboxService(createEnv());
    const longCode = "x".repeat(100 * 1024 + 1);

    await expect(svc.runCode(mockSandbox, longCode)).rejects.toThrow(
      "Code exceeds maximum length"
    );
    expect(mockSandbox.runCode).not.toHaveBeenCalled();
  });

  it("wraps SDK errors with context", async () => {
    mockSandbox.runCode.mockRejectedValueOnce(new Error("Kernel died"));
    const svc = createSandboxService(createEnv());

    await expect(svc.runCode(mockSandbox, "code")).rejects.toThrow(
      "Code execution failed: Kernel died"
    );
  });
});

describe("runCommand", () => {
  it("passes cwd, envs, and timeout to SDK", async () => {
    mockSandbox.commands.run.mockResolvedValueOnce({
      stdout: "output",
      stderr: "",
      exitCode: 0,
    });
    const svc = createSandboxService(createEnv());

    await svc.runCommand(mockSandbox, "ls -la", {
      cwd: "/home/user",
      envs: { PATH: "/usr/bin" },
      timeout: 120,
    });

    expect(mockSandbox.commands.run).toHaveBeenCalledWith("ls -la", {
      cwd: "/home/user",
      envs: { PATH: "/usr/bin" },
      timeoutMs: 120 * 1000,
    });
  });

  it("uses default timeout when not specified", async () => {
    mockSandbox.commands.run.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const svc = createSandboxService(createEnv());

    await svc.runCommand(mockSandbox, "pwd");

    expect(mockSandbox.commands.run).toHaveBeenCalledWith("pwd", {
      cwd: undefined,
      envs: undefined,
      timeoutMs: DEFAULTS.COMMAND_TIMEOUT * 1000,
    });
  });

  it("returns stdout, stderr, and exitCode", async () => {
    mockSandbox.commands.run.mockResolvedValueOnce({
      stdout: "file.txt",
      stderr: "warning: something",
      exitCode: 1,
    });
    const svc = createSandboxService(createEnv());

    const result = await svc.runCommand(mockSandbox, "cat missing.txt");

    expect(result).toEqual({
      stdout: "file.txt",
      stderr: "warning: something",
      exitCode: 1,
    });
  });

  it("rejects command exceeding max length", async () => {
    const svc = createSandboxService(createEnv());
    const longCommand = "x".repeat(10 * 1024 + 1);

    await expect(svc.runCommand(mockSandbox, longCommand)).rejects.toThrow(
      "Command exceeds maximum length"
    );
    expect(mockSandbox.commands.run).not.toHaveBeenCalled();
  });

  it("wraps SDK errors with context", async () => {
    mockSandbox.commands.run.mockRejectedValueOnce(
      new Error("Command timeout")
    );
    const svc = createSandboxService(createEnv());

    await expect(svc.runCommand(mockSandbox, "sleep 1000")).rejects.toThrow(
      "Command execution failed: Command timeout"
    );
  });
});

describe("writeFile", () => {
  it("calls sandbox.files.write with path and content", async () => {
    mockSandbox.files.write.mockResolvedValueOnce(undefined);
    const svc = createSandboxService(createEnv());

    await svc.writeFile(mockSandbox, "/home/user/test.py", "print(1)");

    expect(mockSandbox.files.write).toHaveBeenCalledWith(
      "/home/user/test.py",
      "print(1)"
    );
  });

  it("rejects path with directory traversal", async () => {
    const svc = createSandboxService(createEnv());

    await expect(
      svc.writeFile(mockSandbox, "../../../etc/passwd", "hacked")
    ).rejects.toThrow("Path cannot contain '..'");
    expect(mockSandbox.files.write).not.toHaveBeenCalled();
  });

  it("wraps SDK errors with context", async () => {
    mockSandbox.files.write.mockRejectedValueOnce(new Error("Disk full"));
    const svc = createSandboxService(createEnv());

    await expect(
      svc.writeFile(mockSandbox, "/home/user/test.txt", "content")
    ).rejects.toThrow("Failed to write file: Disk full");
  });
});

describe("readFile", () => {
  it("returns string content directly", async () => {
    mockSandbox.files.read.mockResolvedValueOnce("file content");
    const svc = createSandboxService(createEnv());

    const result = await svc.readFile(mockSandbox, "/home/user/file.txt");

    expect(mockSandbox.files.read).toHaveBeenCalledWith("/home/user/file.txt");
    expect(result).toBe("file content");
  });

  it("decodes Uint8Array content to string", async () => {
    const content = new TextEncoder().encode("binary content");
    mockSandbox.files.read.mockResolvedValueOnce(content);
    const svc = createSandboxService(createEnv());

    const result = await svc.readFile(mockSandbox, "/home/user/binary.dat");

    expect(result).toBe("binary content");
  });

  it("rejects path with directory traversal", async () => {
    const svc = createSandboxService(createEnv());

    await expect(
      svc.readFile(mockSandbox, "/home/../../../etc/shadow")
    ).rejects.toThrow("Path cannot contain '..'");
    expect(mockSandbox.files.read).not.toHaveBeenCalled();
  });

  it("wraps SDK errors with context", async () => {
    mockSandbox.files.read.mockRejectedValueOnce(new Error("File not found"));
    const svc = createSandboxService(createEnv());

    await expect(
      svc.readFile(mockSandbox, "/home/user/missing.txt")
    ).rejects.toThrow("Failed to read file: File not found");
  });
});

describe("kill", () => {
  it("calls sandbox.kill()", async () => {
    mockSandbox.kill.mockResolvedValueOnce(undefined);
    const svc = createSandboxService(createEnv());

    await svc.kill(mockSandbox);

    expect(mockSandbox.kill).toHaveBeenCalled();
  });

  it("wraps SDK errors with context", async () => {
    mockSandbox.kill.mockRejectedValueOnce(new Error("Already terminated"));
    const svc = createSandboxService(createEnv());

    await expect(svc.kill(mockSandbox)).rejects.toThrow(
      "Failed to kill sandbox: Already terminated"
    );
  });
});

describe("setTimeout", () => {
  it("calls sandbox.setTimeout with valid timeout", async () => {
    mockSandbox.setTimeout.mockResolvedValueOnce(undefined);
    const svc = createSandboxService(createEnv());

    await svc.setTimeout(mockSandbox, 60);

    expect(mockSandbox.setTimeout).toHaveBeenCalledWith(60_000);
  });

  it("rejects timeout below minimum (1 second)", async () => {
    const svc = createSandboxService(createEnv());

    await expect(svc.setTimeout(mockSandbox, 0.5)).rejects.toThrow(
      "Timeout must be between 1 and 18000 seconds"
    );
    expect(mockSandbox.setTimeout).not.toHaveBeenCalled();
  });

  it("rejects timeout above maximum (18000 seconds)", async () => {
    const svc = createSandboxService(createEnv());

    await expect(svc.setTimeout(mockSandbox, 18_001)).rejects.toThrow(
      "Timeout must be between 1 and 18000 seconds"
    );
    expect(mockSandbox.setTimeout).not.toHaveBeenCalled();
  });

  it("wraps SDK errors with context", async () => {
    mockSandbox.setTimeout.mockRejectedValueOnce(
      new Error("Invalid operation")
    );
    const svc = createSandboxService(createEnv());

    await expect(svc.setTimeout(mockSandbox, 5)).rejects.toThrow(
      "Failed to set timeout: Invalid operation"
    );
  });
});

describe("isRunning", () => {
  it("returns true when sandbox is running", async () => {
    mockSandbox.isRunning.mockResolvedValueOnce(true);
    const svc = createSandboxService(createEnv());

    const result = await svc.isRunning(mockSandbox);

    expect(result).toBe(true);
    expect(mockSandbox.isRunning).toHaveBeenCalled();
  });

  it("returns false when sandbox is not running", async () => {
    mockSandbox.isRunning.mockResolvedValueOnce(false);
    const svc = createSandboxService(createEnv());

    const result = await svc.isRunning(mockSandbox);

    expect(result).toBe(false);
  });

  it("returns false when SDK check fails", async () => {
    mockSandbox.isRunning.mockRejectedValueOnce(new Error("Connection lost"));
    const svc = createSandboxService(createEnv());

    const result = await svc.isRunning(mockSandbox);

    expect(result).toBe(false);
  });
});

describe("list", () => {
  it("maps paginator results to SandboxInfo[]", async () => {
    let hasNextCalls = 0;
    const mockPaginator = {
      get hasNext() {
        hasNextCalls++;
        return hasNextCalls === 1; // true first time, false after
      },
      nextItems: vi.fn().mockResolvedValueOnce([
        {
          sandboxId: "sbx-1",
          templateId: "python-3.11",
          metadata: { taskId: "t1" },
          startedAt: "2024-01-15T10:00:00Z",
        },
        {
          sandboxId: "sbx-2",
          templateId: null,
          metadata: null,
          startedAt: null,
        },
      ]),
    };
    mockSandboxList.mockReturnValueOnce(
      mockPaginator as E2BPaginator as unknown as ReturnType<
        typeof Sandbox.list
      >
    );
    const svc = createSandboxService(createEnv());

    const result = await svc.list();

    expect(mockSandboxList).toHaveBeenCalledWith({
      apiKey: "test-api-key",
      query: { state: ["running"] },
    });
    expect(result).toEqual([
      {
        sandboxId: "sbx-1",
        template: "python-3.11",
        metadata: { taskId: "t1" },
        startedAt: new Date("2024-01-15T10:00:00Z"),
      },
      {
        sandboxId: "sbx-2",
        template: "unknown",
        metadata: {},
        startedAt: undefined,
      },
    ]);
  });

  it("returns empty array when no sandboxes", async () => {
    const mockPaginator = {
      hasNext: false,
      nextItems: vi.fn().mockResolvedValueOnce([]),
    };
    mockSandboxList.mockReturnValueOnce(
      mockPaginator as E2BPaginator as unknown as ReturnType<
        typeof Sandbox.list
      >
    );
    const svc = createSandboxService(createEnv());

    const result = await svc.list();

    expect(result).toEqual([]);
  });

  it("wraps SDK errors with context", async () => {
    const mockPaginator = {
      hasNext: true,
      nextItems: vi.fn().mockRejectedValueOnce(new Error("API error")),
    };
    mockSandboxList.mockReturnValueOnce(
      mockPaginator as E2BPaginator as unknown as ReturnType<
        typeof Sandbox.list
      >
    );
    const svc = createSandboxService(createEnv());

    await expect(svc.list()).rejects.toThrow(
      "Failed to list sandboxes: API error"
    );
  });
});
