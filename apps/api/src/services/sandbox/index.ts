import { RateLimitError, Sandbox } from "@e2b/code-interpreter";
import type { Env } from "../../types/env";
import { DEFAULT_TEMPLATE, DEFAULTS, TEMPLATES } from "./config";
import type {
  CodeResult,
  CommandResult,
  RunCodeOptions,
  RunCommandOptions,
  SandboxInfo,
  SandboxOptions,
} from "./types";

/** Check if error is an E2B rate limit error */
const isRateLimitError = (error: unknown): boolean =>
  error instanceof RateLimitError;

/** Allowed template values */
type AllowedTemplate = (typeof TEMPLATES)[keyof typeof TEMPLATES];

/** Allowed templates (whitelist to prevent arbitrary template injection) */
const ALLOWED_TEMPLATES = new Set<string>(Object.values(TEMPLATES));

/** Type guard for allowed templates */
const isAllowedTemplate = (template: string): template is AllowedTemplate =>
  ALLOWED_TEMPLATES.has(template);

/** Timeout bounds (seconds) */
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 3600; // 1 hour (hobby tier limit)

/** Sandbox ID format validation (alphanumeric with dashes) */
const SANDBOX_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Max input length limits (bytes) */
const MAX_CODE_LENGTH = 100 * 1024; // 100KB
const MAX_COMMAND_LENGTH = 10 * 1024; // 10KB

/** Max error message length to prevent info leakage */
const MAX_ERROR_LENGTH = 200;

/** Max log output length to prevent memory issues (10KB) */
const MAX_LOG_LENGTH = 10 * 1024;

/** Truncate error message to prevent info leakage */
const truncateError = (message: string): string =>
  message.length > MAX_ERROR_LENGTH
    ? `${message.slice(0, MAX_ERROR_LENGTH)}...`
    : message;

/** Truncate logs to prevent memory issues */
const truncateLogs = (logs: string): string =>
  logs.length > MAX_LOG_LENGTH
    ? `${logs.slice(0, MAX_LOG_LENGTH)}\n...[truncated]`
    : logs;

/** Validate path doesn't escape sandbox (no directory traversal) */
const validatePath = (path: string, context: string): void => {
  if (path.includes("..")) {
    throw new Error(`${context}: Path cannot contain '..'`);
  }
};

/**
 * Validate and bound timeout value.
 * @param timeout - User-provided timeout in seconds
 * @param defaultValue - Default timeout in seconds
 * @returns Validated timeout in seconds
 */
const validateTimeout = (
  timeout: number | undefined,
  defaultValue: number
): number => {
  if (timeout === undefined) {
    return defaultValue;
  }
  if (
    !Number.isFinite(timeout) ||
    timeout < MIN_TIMEOUT_SEC ||
    timeout > MAX_TIMEOUT_SEC
  ) {
    throw new Error(
      `Timeout must be between ${MIN_TIMEOUT_SEC} and ${MAX_TIMEOUT_SEC} seconds`
    );
  }
  return timeout;
};

/**
 * Creates a sandbox service for running AI-generated code in secure E2B cloud sandboxes.
 *
 * Usage:
 * ```ts
 * const svc = createSandboxService(env)
 * const sbx = await svc.create({ metadata: { taskId: '123' } })
 * const result = await svc.runCode(sbx, 'print("hello")')
 * await svc.kill(sbx)
 * ```
 */
export const createSandboxService = (env: Env) => {
  const apiKey = env.E2B_API_KEY;

  // Validate API key is present
  if (!apiKey) {
    throw new Error("E2B_API_KEY environment variable is not configured");
  }

  /**
   * Create a new sandbox with optional configuration.
   * Default: python-3.11 template, 5 minute timeout.
   */
  const create = async (opts?: SandboxOptions): Promise<Sandbox> => {
    const template = opts?.template ?? DEFAULT_TEMPLATE;
    const context = `create(template=${template})`;

    // Validate template against whitelist
    if (!isAllowedTemplate(template)) {
      throw new Error(
        `${context}: Invalid template. Allowed: ${[...ALLOWED_TEMPLATES].join(", ")}`
      );
    }

    const timeoutSec = validateTimeout(opts?.timeout, DEFAULTS.SANDBOX_TIMEOUT);

    try {
      const sandbox = await Sandbox.create(template, {
        apiKey,
        timeoutMs: timeoutSec * 1000,
        metadata: opts?.metadata,
        envs: opts?.envs,
      });

      console.log(`[sandbox] ${context}: Created ${sandbox.sandboxId}`);
      return sandbox;
    } catch (error) {
      // Handle rate limiting specifically
      if (isRateLimitError(error)) {
        console.error(`[sandbox] ${context}: Rate limit exceeded`);
        throw new Error("E2B rate limit exceeded. Please try again later.");
      }
      const message = truncateError(
        error instanceof Error ? error.message : String(error)
      );
      console.error(`[sandbox] ${context}: Failed - ${message}`);
      throw new Error(`Failed to create sandbox: ${message}`);
    }
  };

  /**
   * Connect to an existing sandbox by ID.
   * Useful for reconnecting after worker restart or from different request.
   */
  const connect = async (sandboxId: string): Promise<Sandbox> => {
    const context = `connect(${sandboxId})`;

    // Validate sandbox ID format
    if (!SANDBOX_ID_PATTERN.test(sandboxId)) {
      throw new Error(`${context}: Invalid sandbox ID format`);
    }

    try {
      const sandbox = await Sandbox.connect(sandboxId, { apiKey });
      console.log(`[sandbox] ${context}: Connected`);
      return sandbox;
    } catch (error) {
      const message = truncateError(
        error instanceof Error ? error.message : String(error)
      );
      console.error(`[sandbox] ${context}: Failed - ${message}`);
      throw new Error(`Failed to connect to sandbox: ${message}`);
    }
  };

  /**
   * Execute code in the sandbox.
   * Supports Python (default), TypeScript, and Bash.
   */
  const runCode = async (
    sbx: Sandbox,
    code: string,
    opts?: RunCodeOptions
  ): Promise<CodeResult> => {
    const language = opts?.language ?? "python";
    const context = `runCode(${sbx.sandboxId}, ${language})`;

    // Validate code length to prevent DoS
    if (code.length > MAX_CODE_LENGTH) {
      throw new Error(
        `${context}: Code exceeds maximum length of ${MAX_CODE_LENGTH} bytes`
      );
    }

    const timeoutSec = validateTimeout(opts?.timeout, DEFAULTS.CODE_TIMEOUT);

    try {
      const execution = await sbx.runCode(code, {
        language,
        timeoutMs: timeoutSec * 1000,
      });

      const rawLogs = [...execution.logs.stdout, ...execution.logs.stderr].join(
        "\n"
      );
      const logs = truncateLogs(rawLogs);

      return {
        logs,
        text: execution.text ?? undefined,
        error: execution.error?.value,
      };
    } catch (error) {
      const message = truncateError(
        error instanceof Error ? error.message : String(error)
      );
      console.error(`[sandbox] ${context}: Failed - ${message}`);
      throw new Error(`Code execution failed: ${message}`);
    }
  };

  /**
   * Run a shell command in the sandbox.
   */
  const runCommand = async (
    sbx: Sandbox,
    cmd: string,
    opts?: RunCommandOptions
  ): Promise<CommandResult> => {
    const context = `runCommand(${sbx.sandboxId})`;

    // Validate command length to prevent DoS
    if (cmd.length > MAX_COMMAND_LENGTH) {
      throw new Error(
        `${context}: Command exceeds maximum length of ${MAX_COMMAND_LENGTH} bytes`
      );
    }

    const timeoutSec = validateTimeout(opts?.timeout, DEFAULTS.COMMAND_TIMEOUT);

    try {
      const result = await sbx.commands.run(cmd, {
        cwd: opts?.cwd,
        envs: opts?.envs,
        timeoutMs: timeoutSec * 1000,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (error) {
      const message = truncateError(
        error instanceof Error ? error.message : String(error)
      );
      console.error(`[sandbox] ${context}: Failed - ${message}`);
      throw new Error(`Command execution failed: ${message}`);
    }
  };

  /**
   * Write a file to the sandbox filesystem.
   */
  const writeFile = async (
    sbx: Sandbox,
    path: string,
    content: string
  ): Promise<void> => {
    const context = `writeFile(${sbx.sandboxId}, ${path})`;
    validatePath(path, context);

    try {
      await sbx.files.write(path, content);
    } catch (error) {
      const message = truncateError(
        error instanceof Error ? error.message : String(error)
      );
      console.error(`[sandbox] ${context}: Failed - ${message}`);
      throw new Error(`Failed to write file: ${message}`);
    }
  };

  /**
   * Read a file from the sandbox filesystem.
   */
  const readFile = async (sbx: Sandbox, path: string): Promise<string> => {
    const context = `readFile(${sbx.sandboxId}, ${path})`;
    validatePath(path, context);

    try {
      const content = await sbx.files.read(path);
      if (typeof content === "string") {
        return content;
      }
      return new TextDecoder().decode(content);
    } catch (error) {
      const message = truncateError(
        error instanceof Error ? error.message : String(error)
      );
      console.error(`[sandbox] ${context}: Failed - ${message}`);
      throw new Error(`Failed to read file: ${message}`);
    }
  };

  /**
   * Terminate the sandbox and release resources.
   * IMPORTANT: Must be called to avoid resource leaks and billing.
   */
  const kill = async (sbx: Sandbox): Promise<void> => {
    const context = `kill(${sbx.sandboxId})`;

    try {
      await sbx.kill();
      console.log(`[sandbox] ${context}: Killed`);
    } catch (error) {
      const message = truncateError(
        error instanceof Error ? error.message : String(error)
      );
      console.error(`[sandbox] ${context}: Failed - ${message}`);
      throw new Error(`Failed to kill sandbox: ${message}`);
    }
  };

  /**
   * Extend or reduce sandbox timeout.
   * @param timeoutSec - New timeout in seconds (1-3600)
   */
  const setTimeout = async (
    sbx: Sandbox,
    timeoutSec: number
  ): Promise<void> => {
    const context = `setTimeout(${sbx.sandboxId}, ${timeoutSec}s)`;

    // Validate timeout bounds (in seconds)
    if (
      !Number.isFinite(timeoutSec) ||
      timeoutSec < MIN_TIMEOUT_SEC ||
      timeoutSec > MAX_TIMEOUT_SEC
    ) {
      throw new Error(
        `${context}: Timeout must be between ${MIN_TIMEOUT_SEC} and ${MAX_TIMEOUT_SEC} seconds`
      );
    }

    try {
      await sbx.setTimeout(timeoutSec * 1000);
    } catch (error) {
      const message = truncateError(
        error instanceof Error ? error.message : String(error)
      );
      console.error(`[sandbox] ${context}: Failed - ${message}`);
      throw new Error(`Failed to set timeout: ${message}`);
    }
  };

  /**
   * Check if sandbox is still running.
   */
  const isRunning = async (sbx: Sandbox): Promise<boolean> => {
    try {
      return await sbx.isRunning();
    } catch (_error) {
      // If we can't check, assume not running
      console.warn(
        `[sandbox] isRunning(${sbx.sandboxId}): Check failed, assuming not running`
      );
      return false;
    }
  };

  /**
   * List all running sandboxes.
   * Useful for cleanup and monitoring.
   */
  const list = async (): Promise<SandboxInfo[]> => {
    try {
      const paginator = Sandbox.list({
        apiKey,
        query: { state: ["running"] },
      });

      const allSandboxes: SandboxInfo[] = [];

      // Fetch all pages
      while (paginator.hasNext) {
        const sandboxes = await paginator.nextItems();
        for (const s of sandboxes) {
          allSandboxes.push({
            sandboxId: s.sandboxId,
            template: s.templateId ?? "unknown",
            metadata: s.metadata ?? {},
            startedAt: s.startedAt ? new Date(s.startedAt) : undefined,
          });
        }
      }

      return allSandboxes;
    } catch (error) {
      const message = truncateError(
        error instanceof Error ? error.message : String(error)
      );
      console.error(`[sandbox] list(): Failed - ${message}`);
      throw new Error(`Failed to list sandboxes: ${message}`);
    }
  };

  return {
    create,
    connect,
    runCode,
    runCommand,
    writeFile,
    readFile,
    kill,
    setTimeout,
    isRunning,
    list,
  };
};

export type SandboxService = ReturnType<typeof createSandboxService>;

// biome-ignore lint/performance/noBarrelFile: This is the package's public API
export { DEFAULT_TEMPLATE, DEFAULTS, TEMPLATES } from "./config";
// Re-export types for consumers
export type {
  CodeResult,
  CommandResult,
  RunCodeOptions,
  RunCommandOptions,
  Sandbox,
  SandboxInfo,
  SandboxOptions,
} from "./types";
