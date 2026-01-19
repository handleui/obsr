import { RateLimitError, Sandbox } from "@e2b/code-interpreter";
import { DEFAULT_TEMPLATE, DEFAULTS, TEMPLATES } from "./config.js";
import type {
  CodeResult,
  CommandResult,
  RunCodeOptions,
  RunCommandOptions,
  SandboxInfo,
  SandboxOptions,
} from "./types.js";

const isRateLimitError = (error: unknown): boolean =>
  error instanceof RateLimitError;

type AllowedTemplate = (typeof TEMPLATES)[keyof typeof TEMPLATES];

const ALLOWED_TEMPLATES = new Set<string>(Object.values(TEMPLATES));

const isAllowedTemplate = (template: string): template is AllowedTemplate =>
  ALLOWED_TEMPLATES.has(template);

const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 3600;

const SANDBOX_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const MAX_CODE_LENGTH = 100 * 1024;
const MAX_COMMAND_LENGTH = 10 * 1024;

const MAX_ERROR_LENGTH = 200;

const MAX_LOG_LENGTH = 10 * 1024;

const truncateError = (message: string): string =>
  message.length > MAX_ERROR_LENGTH
    ? `${message.slice(0, MAX_ERROR_LENGTH)}...`
    : message;

const truncateLogs = (logs: string): string =>
  logs.length > MAX_LOG_LENGTH
    ? `${logs.slice(0, MAX_LOG_LENGTH)}\n...[truncated]`
    : logs;

const validatePath = (path: string, context: string): void => {
  if (path.includes("..")) {
    throw new Error(`${context}: Path cannot contain '..'`);
  }
};

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

export const createSandboxService = (apiKey: string) => {
  if (!apiKey) {
    throw new Error("E2B API key is required");
  }

  const create = async (opts?: SandboxOptions): Promise<Sandbox> => {
    const template = opts?.template ?? DEFAULT_TEMPLATE;
    const context = `create(template=${template})`;

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

  const connect = async (sandboxId: string): Promise<Sandbox> => {
    const context = `connect(${sandboxId})`;

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

  const runCode = async (
    sbx: Sandbox,
    code: string,
    opts?: RunCodeOptions
  ): Promise<CodeResult> => {
    const language = opts?.language ?? "python";
    const context = `runCode(${sbx.sandboxId}, ${language})`;

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

  const runCommand = async (
    sbx: Sandbox,
    cmd: string,
    opts?: RunCommandOptions
  ): Promise<CommandResult> => {
    const context = `runCommand(${sbx.sandboxId})`;

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

  const setTimeout = async (
    sbx: Sandbox,
    timeoutSec: number
  ): Promise<void> => {
    const context = `setTimeout(${sbx.sandboxId}, ${timeoutSec}s)`;

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

  const isRunning = async (sbx: Sandbox): Promise<boolean> => {
    try {
      return await sbx.isRunning();
    } catch (_error) {
      console.warn(
        `[sandbox] isRunning(${sbx.sandboxId}): Check failed, assuming not running`
      );
      return false;
    }
  };

  const list = async (): Promise<SandboxInfo[]> => {
    try {
      const sandboxes = await Sandbox.list({ apiKey });

      return sandboxes.map((s) => ({
        sandboxId: s.sandboxId,
        template: s.templateId ?? "unknown",
        metadata: s.metadata ?? {},
        startedAt: s.startedAt ? new Date(s.startedAt) : undefined,
      }));
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
export { DEFAULT_TEMPLATE, DEFAULTS, TEMPLATES } from "./config.js";
export type {
  CodeResult,
  CommandResult,
  RunCodeOptions,
  RunCommandOptions,
  Sandbox,
  SandboxInfo,
  SandboxOptions,
} from "./types.js";
