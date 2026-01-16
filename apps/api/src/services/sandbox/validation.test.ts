import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxService, DEFAULTS, TEMPLATES } from "./index";

// Mock the E2B SDK to isolate validation testing
vi.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    create: vi.fn().mockResolvedValue({
      sandboxId: "test-sandbox-123",
      runCode: vi.fn(),
      commands: { run: vi.fn() },
      files: { write: vi.fn(), read: vi.fn() },
      kill: vi.fn(),
      setTimeout: vi.fn(),
      isRunning: vi.fn(),
    }),
    connect: vi.fn().mockResolvedValue({
      sandboxId: "test-sandbox-123",
    }),
    list: vi.fn().mockReturnValue({
      nextItems: vi.fn().mockResolvedValue([]),
    }),
  },
  RateLimitError: class RateLimitError extends Error {},
}));

const mockEnv = {
  E2B_API_KEY: "test-api-key",
} as Parameters<typeof createSandboxService>[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sandbox validation", () => {
  describe("API key validation", () => {
    it("throws when E2B_API_KEY is missing", () => {
      const envWithoutKey = {} as Parameters<typeof createSandboxService>[0];

      expect(() => createSandboxService(envWithoutKey)).toThrow(
        "E2B_API_KEY environment variable is not configured"
      );
    });

    it("creates service when API key is present", () => {
      const svc = createSandboxService(mockEnv);
      expect(svc).toBeDefined();
      expect(svc.create).toBeDefined();
    });
  });

  describe("validateTimeout", () => {
    const svc = createSandboxService(mockEnv);

    describe("valid timeouts", () => {
      it("accepts minimum timeout (1 second)", async () => {
        await expect(svc.create({ timeout: 1 })).resolves.toBeDefined();
      });

      it("accepts maximum timeout (3600 seconds)", async () => {
        await expect(svc.create({ timeout: 3600 })).resolves.toBeDefined();
      });

      it("accepts mid-range timeout", async () => {
        await expect(svc.create({ timeout: 300 })).resolves.toBeDefined();
      });

      it("uses default timeout when undefined", async () => {
        await expect(svc.create({})).resolves.toBeDefined();
      });
    });

    describe("invalid timeouts", () => {
      it("rejects timeout below minimum (0)", async () => {
        await expect(svc.create({ timeout: 0 })).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });

      it("rejects negative timeout", async () => {
        await expect(svc.create({ timeout: -1 })).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });

      it("rejects timeout above maximum (3601)", async () => {
        await expect(svc.create({ timeout: 3601 })).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });

      it("rejects Infinity", async () => {
        await expect(
          svc.create({ timeout: Number.POSITIVE_INFINITY })
        ).rejects.toThrow("Timeout must be between 1 and 3600 seconds");
      });

      it("rejects -Infinity", async () => {
        await expect(
          svc.create({ timeout: Number.NEGATIVE_INFINITY })
        ).rejects.toThrow("Timeout must be between 1 and 3600 seconds");
      });

      it("rejects NaN", async () => {
        await expect(svc.create({ timeout: Number.NaN })).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });
    });

    describe("edge cases", () => {
      it("accepts exactly at minimum boundary", async () => {
        await expect(svc.create({ timeout: 1 })).resolves.toBeDefined();
      });

      it("accepts exactly at maximum boundary", async () => {
        await expect(svc.create({ timeout: 3600 })).resolves.toBeDefined();
      });

      it("rejects just below minimum (0.9)", async () => {
        await expect(svc.create({ timeout: 0.9 })).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });

      it("rejects just above maximum (3600.1)", async () => {
        await expect(svc.create({ timeout: 3600.1 })).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });
    });
  });

  describe("validatePath (directory traversal prevention)", () => {
    const svc = createSandboxService(mockEnv);

    // Create a mock sandbox for file operations
    const createMockSandbox = () => ({
      sandboxId: "test-sandbox",
      files: {
        write: vi.fn().mockResolvedValue(undefined),
        read: vi.fn().mockResolvedValue("content"),
      },
    });

    describe("valid paths", () => {
      it("accepts simple filename", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.writeFile(sbx as never, "file.txt", "content")
        ).resolves.toBeUndefined();
      });

      it("accepts nested path", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.writeFile(sbx as never, "/home/user/project/file.txt", "content")
        ).resolves.toBeUndefined();
      });

      it("accepts path with single dot", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.writeFile(sbx as never, "./file.txt", "content")
        ).resolves.toBeUndefined();
      });

      it("accepts path with .hidden file", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.writeFile(sbx as never, ".hidden", "content")
        ).resolves.toBeUndefined();
      });
    });

    describe("directory traversal attacks", () => {
      it("rejects path with ..", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.writeFile(sbx as never, "../etc/passwd", "content")
        ).rejects.toThrow("Path cannot contain '..'");
      });

      it("rejects path with .. in middle", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.writeFile(sbx as never, "/home/user/../root/secret", "content")
        ).rejects.toThrow("Path cannot contain '..'");
      });

      it("rejects path with multiple ..", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.writeFile(sbx as never, "../../etc/shadow", "content")
        ).rejects.toThrow("Path cannot contain '..'");
      });

      it("rejects .. at end of path", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.writeFile(sbx as never, "/home/user/..", "content")
        ).rejects.toThrow("Path cannot contain '..'");
      });

      it("rejects readFile with directory traversal", async () => {
        const sbx = createMockSandbox();
        await expect(svc.readFile(sbx as never, "../secret")).rejects.toThrow(
          "Path cannot contain '..'"
        );
      });
    });
  });

  describe("template whitelist (isAllowedTemplate)", () => {
    const svc = createSandboxService(mockEnv);

    describe("allowed templates", () => {
      it("accepts base template", async () => {
        await expect(
          svc.create({ template: TEMPLATES.BASE })
        ).resolves.toBeDefined();
      });

      it("accepts python-3.11 template", async () => {
        await expect(
          svc.create({ template: TEMPLATES.PYTHON })
        ).resolves.toBeDefined();
      });

      it("accepts node-20 template", async () => {
        await expect(
          svc.create({ template: TEMPLATES.NODE })
        ).resolves.toBeDefined();
      });

      it("uses default template when not specified", async () => {
        await expect(svc.create()).resolves.toBeDefined();
      });
    });

    describe("disallowed templates", () => {
      it("rejects arbitrary template name", async () => {
        await expect(
          svc.create({ template: "malicious-template" })
        ).rejects.toThrow(
          "Invalid template. Allowed: base, python-3.11, node-20"
        );
      });

      it("rejects empty string template", async () => {
        await expect(svc.create({ template: "" })).rejects.toThrow(
          "Invalid template. Allowed:"
        );
      });

      it("rejects template with special characters", async () => {
        await expect(
          svc.create({ template: "python; rm -rf /" })
        ).rejects.toThrow("Invalid template. Allowed:");
      });

      it("rejects similar but different template name", async () => {
        await expect(svc.create({ template: "python-3.10" })).rejects.toThrow(
          "Invalid template. Allowed:"
        );
      });

      it("rejects template with path injection", async () => {
        await expect(
          svc.create({ template: "../../../etc/passwd" })
        ).rejects.toThrow("Invalid template. Allowed:");
      });
    });
  });

  describe("input size limits", () => {
    const svc = createSandboxService(mockEnv);

    // Create a mock sandbox for code/command execution
    const createMockSandbox = () => ({
      sandboxId: "test-sandbox",
      runCode: vi.fn().mockResolvedValue({
        logs: { stdout: [], stderr: [] },
        text: "result",
        error: undefined,
      }),
      commands: {
        run: vi.fn().mockResolvedValue({
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
      },
    });

    describe("MAX_CODE_LENGTH (100KB)", () => {
      const MAX_CODE_LENGTH = 100 * 1024;

      it("accepts code at exactly 100KB", async () => {
        const sbx = createMockSandbox();
        const code = "x".repeat(MAX_CODE_LENGTH);
        await expect(svc.runCode(sbx as never, code)).resolves.toBeDefined();
      });

      it("accepts code under 100KB", async () => {
        const sbx = createMockSandbox();
        const code = "print('hello')";
        await expect(svc.runCode(sbx as never, code)).resolves.toBeDefined();
      });

      it("rejects code exceeding 100KB", async () => {
        const sbx = createMockSandbox();
        const code = "x".repeat(MAX_CODE_LENGTH + 1);
        await expect(svc.runCode(sbx as never, code)).rejects.toThrow(
          `Code exceeds maximum length of ${MAX_CODE_LENGTH} bytes`
        );
      });

      it("rejects significantly oversized code", async () => {
        const sbx = createMockSandbox();
        const code = "x".repeat(MAX_CODE_LENGTH * 2);
        await expect(svc.runCode(sbx as never, code)).rejects.toThrow(
          "Code exceeds maximum length"
        );
      });
    });

    describe("MAX_COMMAND_LENGTH (10KB)", () => {
      const MAX_COMMAND_LENGTH = 10 * 1024;

      it("accepts command at exactly 10KB", async () => {
        const sbx = createMockSandbox();
        const cmd = "x".repeat(MAX_COMMAND_LENGTH);
        await expect(svc.runCommand(sbx as never, cmd)).resolves.toBeDefined();
      });

      it("accepts command under 10KB", async () => {
        const sbx = createMockSandbox();
        const cmd = "ls -la";
        await expect(svc.runCommand(sbx as never, cmd)).resolves.toBeDefined();
      });

      it("rejects command exceeding 10KB", async () => {
        const sbx = createMockSandbox();
        const cmd = "x".repeat(MAX_COMMAND_LENGTH + 1);
        await expect(svc.runCommand(sbx as never, cmd)).rejects.toThrow(
          `Command exceeds maximum length of ${MAX_COMMAND_LENGTH} bytes`
        );
      });

      it("rejects significantly oversized command", async () => {
        const sbx = createMockSandbox();
        const cmd = "x".repeat(MAX_COMMAND_LENGTH * 2);
        await expect(svc.runCommand(sbx as never, cmd)).rejects.toThrow(
          "Command exceeds maximum length"
        );
      });
    });
  });

  describe("sandbox ID validation (SANDBOX_ID_PATTERN)", () => {
    const svc = createSandboxService(mockEnv);

    describe("valid sandbox IDs", () => {
      it("accepts alphanumeric ID", async () => {
        await expect(svc.connect("abc123")).resolves.toBeDefined();
      });

      it("accepts ID with dashes", async () => {
        await expect(svc.connect("sandbox-abc-123")).resolves.toBeDefined();
      });

      it("accepts ID with underscores", async () => {
        await expect(svc.connect("sandbox_abc_123")).resolves.toBeDefined();
      });

      it("accepts single character ID", async () => {
        await expect(svc.connect("a")).resolves.toBeDefined();
      });

      it("accepts 64 character ID (max length)", async () => {
        const id = "a".repeat(64);
        await expect(svc.connect(id)).resolves.toBeDefined();
      });

      it("accepts mixed case ID", async () => {
        await expect(svc.connect("SandBox-ABC-123")).resolves.toBeDefined();
      });
    });

    describe("invalid sandbox IDs", () => {
      it("rejects empty string", async () => {
        await expect(svc.connect("")).rejects.toThrow(
          "Invalid sandbox ID format"
        );
      });

      it("rejects ID exceeding 64 characters", async () => {
        const id = "a".repeat(65);
        await expect(svc.connect(id)).rejects.toThrow(
          "Invalid sandbox ID format"
        );
      });

      it("rejects ID with spaces", async () => {
        await expect(svc.connect("sandbox 123")).rejects.toThrow(
          "Invalid sandbox ID format"
        );
      });

      it("rejects ID with special characters", async () => {
        await expect(svc.connect("sandbox@123")).rejects.toThrow(
          "Invalid sandbox ID format"
        );
      });

      it("rejects ID with dots", async () => {
        await expect(svc.connect("sandbox.123")).rejects.toThrow(
          "Invalid sandbox ID format"
        );
      });

      it("rejects ID with slashes (path injection)", async () => {
        await expect(svc.connect("../sandbox")).rejects.toThrow(
          "Invalid sandbox ID format"
        );
      });

      it("rejects ID with semicolon (command injection)", async () => {
        await expect(svc.connect("sandbox;rm -rf /")).rejects.toThrow(
          "Invalid sandbox ID format"
        );
      });

      it("rejects ID with newline", async () => {
        await expect(svc.connect("sandbox\n123")).rejects.toThrow(
          "Invalid sandbox ID format"
        );
      });
    });
  });

  describe("setTimeout validation", () => {
    const svc = createSandboxService(mockEnv);

    const createMockSandbox = () => ({
      sandboxId: "test-sandbox",
      setTimeout: vi.fn().mockResolvedValue(undefined),
    });

    describe("valid timeouts (in seconds)", () => {
      it("accepts minimum timeout (1 second)", async () => {
        const sbx = createMockSandbox();
        await expect(svc.setTimeout(sbx as never, 1)).resolves.toBeUndefined();
      });

      it("accepts maximum timeout (3600 seconds = 1 hour)", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.setTimeout(sbx as never, 3600)
        ).resolves.toBeUndefined();
      });

      it("accepts mid-range timeout", async () => {
        const sbx = createMockSandbox();
        await expect(svc.setTimeout(sbx as never, 60)).resolves.toBeUndefined();
      });
    });

    describe("invalid timeouts (in seconds)", () => {
      it("rejects timeout below minimum (0.5 seconds)", async () => {
        const sbx = createMockSandbox();
        await expect(svc.setTimeout(sbx as never, 0.5)).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });

      it("rejects timeout above maximum (3601 seconds)", async () => {
        const sbx = createMockSandbox();
        await expect(svc.setTimeout(sbx as never, 3601)).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });

      it("rejects zero timeout", async () => {
        const sbx = createMockSandbox();
        await expect(svc.setTimeout(sbx as never, 0)).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });

      it("rejects negative timeout", async () => {
        const sbx = createMockSandbox();
        await expect(svc.setTimeout(sbx as never, -1)).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });

      it("rejects Infinity", async () => {
        const sbx = createMockSandbox();
        await expect(
          svc.setTimeout(sbx as never, Number.POSITIVE_INFINITY)
        ).rejects.toThrow("Timeout must be between 1 and 3600 seconds");
      });

      it("rejects NaN", async () => {
        const sbx = createMockSandbox();
        await expect(svc.setTimeout(sbx as never, Number.NaN)).rejects.toThrow(
          "Timeout must be between 1 and 3600 seconds"
        );
      });
    });
  });

  describe("defaults configuration", () => {
    it("exports expected default values", () => {
      expect(DEFAULTS.SANDBOX_TIMEOUT).toBe(300);
      expect(DEFAULTS.COMMAND_TIMEOUT).toBe(60);
      expect(DEFAULTS.CODE_TIMEOUT).toBe(30);
    });

    it("exports expected templates", () => {
      expect(TEMPLATES.BASE).toBe("base");
      expect(TEMPLATES.PYTHON).toBe("python-3.11");
      expect(TEMPLATES.NODE).toBe("node-20");
    });
  });
});
