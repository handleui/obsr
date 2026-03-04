import { DEFAULT_TEMPLATE, DEFAULTS, TEMPLATES } from "./config.js";
import { createDaytonaProvider } from "./providers/daytona.js";
import { createE2BProvider } from "./providers/e2b.js";
import { createVercelProvider } from "./providers/vercel.js";
import type {
  CodeResult,
  CommandResult,
  RunCodeOptions,
  RunCommandOptions,
  SandboxEnv,
  SandboxHandle,
  SandboxInfo,
  SandboxOptions,
  SandboxProvider,
  SandboxProviderName,
} from "./types.js";

const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 18_000;

const SANDBOX_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const MAX_CODE_LENGTH = 100 * 1024;
const MAX_COMMAND_LENGTH = 10 * 1024;

const MAX_ERROR_LENGTH = 200;
const MAX_LOG_LENGTH = 10 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ENV_VALUE_BYTES = 8 * 1024;
const MAX_ENV_KEY_BYTES = 256;

const PROVIDER_ROOTS: Record<SandboxProviderName, string> = {
  daytona: "/workspace",
  e2b: "/home/user",
  vercel: "/vercel/sandbox",
};
const LEGACY_ROOT = "/home/user";
const MULTI_SLASH_RE = /\/+/g;
const TRAILING_SLASH_RE = /\/$/;
const ENV_KEY_RE = /^[A-Z0-9_]+$/;

const truncateError = (message: string): string =>
  message.length > MAX_ERROR_LENGTH
    ? `${message.slice(0, MAX_ERROR_LENGTH)}...`
    : message;

const truncateLogs = (logs: string): string =>
  logs.length > MAX_LOG_LENGTH
    ? `${logs.slice(0, MAX_LOG_LENGTH)}\n...[truncated]`
    : logs;

const toSandboxError = (
  error: unknown,
  context: string,
  userMessage: string
): Error => {
  const message = truncateError(
    error instanceof Error ? error.message : String(error)
  );
  console.error(`[sandbox] ${context}: Failed - ${message}`);
  return new Error(`${userMessage}: ${message}`);
};

const validatePath = (path: string, context: string): void => {
  if (path.trim() === "") {
    throw new Error(`${context}: Path is required`);
  }
  if (path.includes("\0")) {
    throw new Error(`${context}: Path contains invalid characters`);
  }
  if (path.includes("..")) {
    throw new Error(`${context}: Path cannot contain '..'`);
  }
  if (path.includes("~")) {
    throw new Error(`${context}: Path cannot contain '~'`);
  }
};

const normalizePath = (path: string): string =>
  path.replace(MULTI_SLASH_RE, "/").replace(TRAILING_SLASH_RE, "");

const resolvePath = (
  rawPath: string,
  rootPath: string,
  context: string
): string => {
  validatePath(rawPath, context);
  let resolved = rawPath;
  if (!resolved.startsWith("/")) {
    resolved = `${rootPath}/${resolved}`;
  }
  if (rootPath === PROVIDER_ROOTS.vercel && resolved.startsWith(LEGACY_ROOT)) {
    resolved = `${rootPath}${resolved.slice(LEGACY_ROOT.length)}`;
  }
  resolved = normalizePath(resolved);
  if (!resolved.startsWith(rootPath)) {
    throw new Error(`${context}: Path must be under ${rootPath}`);
  }
  return resolved;
};

const isValidEnvEntry = (key: string, value: string): boolean => {
  if (key.length === 0 || key.length > MAX_ENV_KEY_BYTES) {
    return false;
  }
  if (!ENV_KEY_RE.test(key)) {
    return false;
  }
  return new TextEncoder().encode(value).length <= MAX_ENV_VALUE_BYTES;
};

const sanitizeEnv = (
  envs?: Record<string, string>
): Record<string, string> | undefined => {
  if (!envs) {
    return undefined;
  }
  const sanitized = Object.entries(envs).filter(([key, value]) =>
    isValidEnvEntry(key, value)
  );
  return sanitized.length ? Object.fromEntries(sanitized) : {};
};

const validatePayloadSize = (value: string, context: string): void => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length > MAX_FILE_BYTES) {
    throw new Error(`${context}: Content exceeds ${MAX_FILE_BYTES} bytes`);
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

const normalizeProvider = (value?: string): SandboxProviderName => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "daytona";
  }
  if (
    normalized === "daytona" ||
    normalized === "e2b" ||
    normalized === "vercel"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported SANDBOX_PROVIDER: ${value}`);
};

const resolveVercelAuth = (env: SandboxEnv) => {
  const token = env.VERCEL_TOKEN;
  const teamId = env.VERCEL_TEAM_ID;
  const projectId = env.VERCEL_PROJECT_ID;

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }

  throw new Error(
    "Vercel sandbox auth requires VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID"
  );
};

const createProvider = (env: SandboxEnv): SandboxProvider => {
  const providerName = normalizeProvider(env.SANDBOX_PROVIDER);
  if (providerName === "daytona") {
    const daytonaAuth = {
      apiKey: env.DAYTONA_API_KEY,
      apiUrl: env.DAYTONA_API_URL,
      target: env.DAYTONA_TARGET,
      organizationId: env.DAYTONA_ORGANIZATION_ID,
      jwtToken: env.DAYTONA_JWT_TOKEN,
    };
    if (!(daytonaAuth.apiKey || daytonaAuth.jwtToken)) {
      throw new Error(
        "DAYTONA provider requires DAYTONA_API_KEY or DAYTONA_JWT_TOKEN"
      );
    }
    return createDaytonaProvider(daytonaAuth);
  }

  if (providerName === "e2b") {
    console.warn(
      "[sandbox] SANDBOX_PROVIDER=e2b is deprecated. Use daytona for idempotent sandboxes."
    );
    if (!env.E2B_API_KEY) {
      throw new Error("E2B_API_KEY environment variable is not configured");
    }
    return createE2BProvider({ apiKey: env.E2B_API_KEY });
  }

  if (providerName === "vercel") {
    console.warn(
      "[sandbox] SANDBOX_PROVIDER=vercel is deprecated. Use daytona for idempotent sandboxes."
    );
  }

  const auth = resolveVercelAuth(env);
  return createVercelProvider(auth);
};

export const createSandboxService = (env: SandboxEnv) => {
  const provider = createProvider(env);
  const rootPath = PROVIDER_ROOTS[provider.name];

  type AllowedTemplate = (typeof TEMPLATES)[keyof typeof TEMPLATES];
  const allowedTemplates = new Set<string>(Object.values(TEMPLATES));
  const isAllowedTemplate = (template: string): template is AllowedTemplate =>
    allowedTemplates.has(template);

  const create = async (opts?: SandboxOptions): Promise<SandboxHandle> => {
    const template = opts?.template ?? DEFAULT_TEMPLATE;
    const context = `create(template=${template})`;

    if (!isAllowedTemplate(template)) {
      throw new Error(
        `${context}: Invalid template. Allowed: ${[...allowedTemplates].join(", ")}`
      );
    }

    const timeoutSec = validateTimeout(opts?.timeout, DEFAULTS.SANDBOX_TIMEOUT);

    try {
      const sandbox = await provider.create({
        ...opts,
        template,
        timeout: timeoutSec,
      });
      console.log(`[sandbox] ${context}: Created ${sandbox.sandboxId}`);
      return sandbox;
    } catch (error) {
      if (provider.isRateLimitError(error)) {
        console.error(`[sandbox] ${context}: Rate limit exceeded`);
        throw new Error("Sandbox rate limit exceeded. Please try again later.");
      }
      throw toSandboxError(error, context, "Failed to create sandbox");
    }
  };

  const connect = async (sandboxId: string): Promise<SandboxHandle> => {
    const context = `connect(${sandboxId})`;

    if (!SANDBOX_ID_PATTERN.test(sandboxId)) {
      throw new Error(`${context}: Invalid sandbox ID format`);
    }

    try {
      const sandbox = await provider.connect(sandboxId);
      console.log(`[sandbox] ${context}: Connected`);
      return sandbox;
    } catch (error) {
      throw toSandboxError(error, context, "Failed to connect to sandbox");
    }
  };

  const runCode = async (
    sbx: Awaited<ReturnType<typeof create>>,
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
        error: execution.error?.value ?? undefined,
      };
    } catch (error) {
      throw toSandboxError(error, context, "Code execution failed");
    }
  };

  const runCommand = async (
    sbx: Awaited<ReturnType<typeof create>>,
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
        cwd: opts?.cwd ? resolvePath(opts.cwd, rootPath, context) : undefined,
        envs: sanitizeEnv(opts?.envs),
        timeoutMs: timeoutSec * 1000,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (error) {
      throw toSandboxError(error, context, "Command execution failed");
    }
  };

  const writeFile = async (
    sbx: Awaited<ReturnType<typeof create>>,
    path: string,
    content: string
  ): Promise<void> => {
    const context = `writeFile(${sbx.sandboxId}, ${path})`;
    const resolvedPath = resolvePath(path, rootPath, context);
    validatePayloadSize(content, context);

    try {
      await sbx.files.write(resolvedPath, content);
    } catch (error) {
      throw toSandboxError(error, context, "Failed to write file");
    }
  };

  const decodeFileContent = (
    content: string | Uint8Array,
    context: string
  ): string => {
    const text =
      typeof content === "string" ? content : new TextDecoder().decode(content);
    validatePayloadSize(text, context);
    return text;
  };

  const readFile = async (
    sbx: Awaited<ReturnType<typeof create>>,
    path: string
  ): Promise<string> => {
    const context = `readFile(${sbx.sandboxId}, ${path})`;
    const resolvedPath = resolvePath(path, rootPath, context);

    try {
      const content = await sbx.files.read(resolvedPath);
      return decodeFileContent(content, context);
    } catch (error) {
      throw toSandboxError(error, context, "Failed to read file");
    }
  };

  const kill = async (
    sbx: Awaited<ReturnType<typeof create>>
  ): Promise<void> => {
    const context = `kill(${sbx.sandboxId})`;

    try {
      await sbx.kill();
      console.log(`[sandbox] ${context}: Killed`);
    } catch (error) {
      throw toSandboxError(error, context, "Failed to kill sandbox");
    }
  };

  const setTimeout = async (
    sbx: Awaited<ReturnType<typeof create>>,
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
      throw toSandboxError(error, context, "Failed to set timeout");
    }
  };

  const isRunning = async (
    sbx: Awaited<ReturnType<typeof create>>
  ): Promise<boolean> => {
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
      return await provider.list();
    } catch (error) {
      throw toSandboxError(error, "list()", "Failed to list sandboxes");
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
    provider: provider.name,
    rootPath,
  };
};

export type SandboxService = ReturnType<typeof createSandboxService>;

export { RateLimitError, Sandbox as E2BSandbox } from "@e2b/code-interpreter";
export { DEFAULT_TEMPLATE, DEFAULTS, TEMPLATES } from "./config.js";
export type {
  CodeResult,
  CommandResult,
  RunCodeOptions,
  RunCommandOptions,
  SandboxCodeExecution,
  SandboxCommandExecution,
  SandboxFileInfo,
  SandboxHandle,
  SandboxInfo,
  SandboxOptions,
  SandboxProviderName,
} from "./types.js";
