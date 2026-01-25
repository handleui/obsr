import { beforeEach, describe, expect, it, vi } from "vitest";

const TRAILING_ELLIPSIS = /\.\.\.$/;

const { mockCreate, mockConnect, mockList, MockRateLimitError } = vi.hoisted(
  () => {
    class MockRateLimitError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "RateLimitError";
      }
    }
    return {
      mockCreate: vi.fn(),
      mockConnect: vi.fn(),
      mockList: vi.fn(),
      MockRateLimitError,
    };
  }
);

vi.mock("@e2b/code-interpreter", () => ({
  RateLimitError: MockRateLimitError,
  Sandbox: {
    create: mockCreate,
    connect: mockConnect,
    list: mockList,
  },
}));

import { createSandboxService as createBaseSandboxService } from "./index.js";

const createSandboxService = (apiKey: string) =>
  createBaseSandboxService({
    SANDBOX_PROVIDER: "e2b",
    E2B_API_KEY: apiKey,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("truncateError", () => {
  it("passes through messages under 200 chars unchanged", async () => {
    const shortMessage = "Short error message";
    mockCreate.mockRejectedValueOnce(new Error(shortMessage));

    const svc = createSandboxService("test-api-key");
    await expect(svc.create()).rejects.toThrow(shortMessage);
  });

  it("truncates messages over 200 chars with ellipsis", async () => {
    const longMessage = "x".repeat(250);
    mockCreate.mockRejectedValueOnce(new Error(longMessage));

    const svc = createSandboxService("test-api-key");
    try {
      await svc.create();
      expect.fail("Should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("x".repeat(200));
      expect(message).toContain("...");
      expect(message).not.toContain("x".repeat(201));
    }
  });

  it("truncates at exactly 200 char boundary", async () => {
    const exactMessage = "y".repeat(200);
    mockCreate.mockRejectedValueOnce(new Error(exactMessage));

    const svc = createSandboxService("test-api-key");
    try {
      await svc.create();
      expect.fail("Should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(exactMessage);
      expect(message).not.toMatch(TRAILING_ELLIPSIS);
    }
  });

  it("truncates at 201 char boundary", async () => {
    const overBoundary = "z".repeat(201);
    mockCreate.mockRejectedValueOnce(new Error(overBoundary));

    const svc = createSandboxService("test-api-key");
    try {
      await svc.create();
      expect.fail("Should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("z".repeat(200));
      expect(message).toContain("...");
    }
  });
});

describe("truncateLogs", () => {
  it("passes through logs under 10KB unchanged", async () => {
    const shortLogs = "short log output";
    const mockExecution = {
      logs: { stdout: [shortLogs], stderr: [] },
      text: null,
      error: null,
    };

    const mockSandbox = {
      sandboxId: "sbx-123",
      runCode: vi.fn().mockResolvedValue(mockExecution),
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    const result = await svc.runCode(sbx as never, 'print("hello")');

    expect(result.logs).toBe(shortLogs);
  });

  it("truncates logs over 10KB with suffix", async () => {
    const tenKB = 10 * 1024;
    const longLogs = "a".repeat(tenKB + 100);
    const mockExecution = {
      logs: { stdout: [longLogs], stderr: [] },
      text: null,
      error: null,
    };

    const mockSandbox = {
      sandboxId: "sbx-123",
      runCode: vi.fn().mockResolvedValue(mockExecution),
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    const result = await svc.runCode(sbx as never, 'print("hello")');

    expect(result.logs).toContain("a".repeat(tenKB));
    expect(result.logs).toContain("\n...[truncated]");
    expect(result.logs.length).toBeLessThan(longLogs.length);
  });

  it("does not truncate logs at exactly 10KB", async () => {
    const exactTenKB = "b".repeat(10 * 1024);
    const mockExecution = {
      logs: { stdout: [exactTenKB], stderr: [] },
      text: null,
      error: null,
    };

    const mockSandbox = {
      sandboxId: "sbx-123",
      runCode: vi.fn().mockResolvedValue(mockExecution),
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    const result = await svc.runCode(sbx as never, 'print("hello")');

    expect(result.logs).toBe(exactTenKB);
    expect(result.logs).not.toContain("[truncated]");
  });

  it("truncates at 10KB + 1 byte boundary", async () => {
    const overBoundary = "c".repeat(10 * 1024 + 1);
    const mockExecution = {
      logs: { stdout: [overBoundary], stderr: [] },
      text: null,
      error: null,
    };

    const mockSandbox = {
      sandboxId: "sbx-123",
      runCode: vi.fn().mockResolvedValue(mockExecution),
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    const result = await svc.runCode(sbx as never, 'print("hello")');

    expect(result.logs).toContain("c".repeat(10 * 1024));
    expect(result.logs).toContain("\n...[truncated]");
  });
});

describe("isRateLimitError", () => {
  it("identifies RateLimitError and provides user-friendly message", async () => {
    const rateLimitError = new MockRateLimitError("Too many requests");
    mockCreate.mockRejectedValueOnce(rateLimitError);

    const svc = createSandboxService("test-api-key");
    await expect(svc.create()).rejects.toThrow(
      "Sandbox rate limit exceeded. Please try again later."
    );
  });

  it("does not treat regular errors as rate limit errors", async () => {
    const regularError = new Error("Some other error");
    mockCreate.mockRejectedValueOnce(regularError);

    const svc = createSandboxService("test-api-key");
    await expect(svc.create()).rejects.toThrow(
      "Failed to create sandbox: Some other error"
    );
  });

  it("handles rate limit error with empty message", async () => {
    const rateLimitError = new MockRateLimitError("");
    mockCreate.mockRejectedValueOnce(rateLimitError);

    const svc = createSandboxService("test-api-key");
    await expect(svc.create()).rejects.toThrow(
      "Sandbox rate limit exceeded. Please try again later."
    );
  });
});

describe("error wrapping in service methods", () => {
  it("wraps create errors with context prefix", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Connection refused"));

    const svc = createSandboxService("test-api-key");
    await expect(svc.create()).rejects.toThrow(
      "Failed to create sandbox: Connection refused"
    );
  });

  it("wraps connect errors with context prefix", async () => {
    mockConnect.mockRejectedValueOnce(new Error("Sandbox not found"));

    const svc = createSandboxService("test-api-key");
    await expect(svc.connect("sbx-valid123")).rejects.toThrow(
      "Failed to connect to sandbox: Sandbox not found"
    );
  });

  it("wraps runCode errors with context prefix", async () => {
    const mockSandbox = {
      sandboxId: "sbx-123",
      runCode: vi.fn().mockRejectedValue(new Error("Execution timeout")),
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    await expect(svc.runCode(sbx as never, "code")).rejects.toThrow(
      "Code execution failed: Execution timeout"
    );
  });

  it("wraps runCommand errors with context prefix", async () => {
    const mockSandbox = {
      sandboxId: "sbx-123",
      commands: {
        run: vi.fn().mockRejectedValue(new Error("Command failed")),
      },
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    await expect(svc.runCommand(sbx as never, "ls")).rejects.toThrow(
      "Command execution failed: Command failed"
    );
  });

  it("wraps writeFile errors with context prefix", async () => {
    const mockSandbox = {
      sandboxId: "sbx-123",
      files: {
        write: vi.fn().mockRejectedValue(new Error("Disk full")),
      },
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    await expect(
      svc.writeFile(sbx as never, "/home/user/test.txt", "content")
    ).rejects.toThrow("Failed to write file: Disk full");
  });

  it("wraps readFile errors with context prefix", async () => {
    const mockSandbox = {
      sandboxId: "sbx-123",
      files: {
        read: vi.fn().mockRejectedValue(new Error("File not found")),
      },
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    await expect(
      svc.readFile(sbx as never, "/home/user/missing.txt")
    ).rejects.toThrow("Failed to read file: File not found");
  });

  it("wraps kill errors with context prefix", async () => {
    const mockSandbox = {
      sandboxId: "sbx-123",
      kill: vi.fn().mockRejectedValue(new Error("Already terminated")),
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    await expect(svc.kill(sbx as never)).rejects.toThrow(
      "Failed to kill sandbox: Already terminated"
    );
  });

  it("wraps setTimeout errors with context prefix", async () => {
    const mockSandbox = {
      sandboxId: "sbx-123",
      setTimeout: vi.fn().mockRejectedValue(new Error("Invalid timeout")),
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    await expect(svc.setTimeout(sbx as never, 60)).rejects.toThrow(
      "Failed to set timeout: Invalid timeout"
    );
  });

  it("wraps list errors with context prefix", async () => {
    mockList.mockRejectedValueOnce(new Error("API unreachable"));

    const svc = createSandboxService("test-api-key");
    await expect(svc.list()).rejects.toThrow(
      "Failed to list sandboxes: API unreachable"
    );
  });

  it("converts non-Error objects to string in error messages", async () => {
    mockCreate.mockRejectedValueOnce("string error");

    const svc = createSandboxService("test-api-key");
    await expect(svc.create()).rejects.toThrow(
      "Failed to create sandbox: string error"
    );
  });

  it("handles null error values", async () => {
    mockCreate.mockRejectedValueOnce(null);

    const svc = createSandboxService("test-api-key");
    await expect(svc.create()).rejects.toThrow(
      "Failed to create sandbox: null"
    );
  });
});

describe("missing API key detection", () => {
  it("throws at service creation when API key is empty", () => {
    expect(() => createSandboxService("")).toThrow(
      "E2B_API_KEY environment variable is not configured"
    );
  });

  it("allows service creation with valid API key", () => {
    expect(() => createSandboxService("valid-key-123")).not.toThrow();
  });
});

describe("isRunning error handling", () => {
  it("returns false when isRunning check fails", async () => {
    const mockSandbox = {
      sandboxId: "sbx-123",
      isRunning: vi.fn().mockRejectedValue(new Error("Network error")),
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    const result = await svc.isRunning(sbx as never);

    expect(result).toBe(false);
  });

  it("returns true when sandbox is running", async () => {
    const mockSandbox = {
      sandboxId: "sbx-123",
      isRunning: vi.fn().mockResolvedValue(true),
    };
    mockCreate.mockResolvedValueOnce(mockSandbox);

    const svc = createSandboxService("test-api-key");
    const sbx = await svc.create();
    const result = await svc.isRunning(sbx as never);

    expect(result).toBe(true);
  });
});
