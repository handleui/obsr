import { DEFAULT_FAST_MODEL, DEFAULT_SMART_MODEL } from "@detent/ai";
import {
  createConfig,
  createToolRegistry,
  ResolveLoop,
  type ResolveResult,
  SYSTEM_PROMPT,
} from "@detent/resolving";
import { z } from "zod";
import {
  createSandboxToolContext,
  createSandboxTools,
} from "../adapters/sandbox-tools.js";
import type { Env } from "../env.js";
import type { SandboxHandle } from "./sandbox/index.js";
import { createSandboxService } from "./sandbox/index.js";

const SANDBOX_TEMPLATE = "base";
const SANDBOX_TIMEOUT_SEC = 600;
const CLONE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000;
const GIT_DIFF_TIMEOUT_MS = 30_000;
const MAX_STDERR_PREVIEW = 500;

const MAX_RESOLVE_ID_LENGTH = 128;
const MAX_BRANCH_LENGTH = 256;
const MAX_REPO_URL_LENGTH = 2048;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_REMAINING_MONTHLY_USD = 10_000;

const SAFE_STRING_PATTERN = /^[a-zA-Z0-9_\-./]+$/;

// SECURITY: Token portion restricted to [a-zA-Z0-9_-] to prevent shell injection via $() or backticks in git clone
const GITHUB_REPO_URL_PATTERN =
  /^https:\/\/(x-access-token:[a-zA-Z0-9_-]+@)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\.git$/;

const ALLOWED_RESOLVE_MODELS = new Set([
  DEFAULT_FAST_MODEL,
  DEFAULT_SMART_MODEL,
]);

const resolveRequestSchema = z.object({
  resolveId: z
    .string()
    .min(1)
    .max(MAX_RESOLVE_ID_LENGTH)
    .regex(SAFE_STRING_PATTERN, "Invalid resolve ID format"),
  repoUrl: z
    .string()
    .min(1)
    .max(MAX_REPO_URL_LENGTH)
    .regex(GITHUB_REPO_URL_PATTERN, "Invalid GitHub repository URL"),
  branch: z
    .string()
    .min(1)
    .max(MAX_BRANCH_LENGTH)
    .regex(SAFE_STRING_PATTERN, "Invalid branch name"),
  userPrompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  model: z
    .string()
    .min(1)
    .max(100)
    .refine(
      (m) => ALLOWED_RESOLVE_MODELS.has(m),
      "Model not in server allowlist"
    )
    .optional(),
  budgetPerRunUSD: z.number().positive().max(100).optional(),
  remainingMonthlyUSD: z.number().max(MAX_REMAINING_MONTHLY_USD).optional(),
});

export interface ResolveRequest {
  resolveId: string;
  repoUrl: string;
  branch: string;
  userPrompt: string;
  model?: string;
  budgetPerRunUSD?: number;
  remainingMonthlyUSD?: number;
}

interface ResolveResponse {
  success: boolean;
  patch: string | null;
  filesChanged: string[];
  result: {
    model: string;
    iterations: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    finalMessage: string;
    commandLog?: Array<{
      tool: string;
      durationMs: number;
      isError: boolean;
      timestamp: number;
    }>;
  };
  error?: string;
}

const detectPackageManager = async (
  sandbox: SandboxHandle,
  worktreePath: string
): Promise<"bun" | "pnpm" | "yarn" | "npm" | null> => {
  const lockFiles = [
    { file: "bun.lockb", manager: "bun" as const },
    { file: "bun.lock", manager: "bun" as const },
    { file: "pnpm-lock.yaml", manager: "pnpm" as const },
    { file: "yarn.lock", manager: "yarn" as const },
    { file: "package-lock.json", manager: "npm" as const },
  ];

  const checks = await Promise.all(
    lockFiles.map(async ({ file, manager }) => ({
      manager,
      exists: await sandbox.files.exists(`${worktreePath}/${file}`),
    }))
  );

  for (const { manager, exists } of checks) {
    if (exists) {
      return manager;
    }
  }

  const hasPackageJson = await sandbox.files.exists(
    `${worktreePath}/package.json`
  );
  return hasPackageJson ? "npm" : null;
};

const installDependencies = async (
  sandbox: SandboxHandle,
  worktreePath: string
): Promise<void> => {
  const manager = await detectPackageManager(sandbox, worktreePath);
  if (!manager) {
    return;
  }

  const installCmd =
    manager === "npm" ? "npm ci --prefer-offline" : `${manager} install`;

  console.log(`[resolve-executor] Installing dependencies with ${manager}`);

  const result = await sandbox.commands.run(installCmd, {
    cwd: worktreePath,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    const safeStderr = sanitizeForLogging(
      result.stderr?.slice(0, MAX_STDERR_PREVIEW) ?? ""
    );
    throw new Error(
      `Dependency install failed (exit ${result.exitCode}): ${safeStderr}`
    );
  }
};

const extractPatch = async (
  sandbox: SandboxHandle,
  worktreePath: string
): Promise<string | null> => {
  const result = await sandbox.commands.run("git diff", {
    cwd: worktreePath,
    timeoutMs: GIT_DIFF_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    console.error(`[resolve-executor] git diff failed: ${result.stderr}`);
    return null;
  }

  const patch = result.stdout.trim();
  return patch === "" ? null : patch;
};

const extractFilesChanged = async (
  sandbox: SandboxHandle,
  worktreePath: string
): Promise<string[]> => {
  const result = await sandbox.commands.run("git diff --name-only", {
    cwd: worktreePath,
    timeoutMs: GIT_DIFF_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .filter((f) => f !== "");
};

const TOKEN_PATTERN = /x-access-token:[^@]+@/;

const sanitizeForLogging = (value: string): string => {
  if (value.includes("x-access-token:")) {
    return value.replace(TOKEN_PATTERN, "x-access-token:****@");
  }
  return value;
};

const CLEANUP_MAX_ATTEMPTS = 3;
const CLEANUP_RETRY_DELAY_MS = 1000;

const cleanupSandbox = async (sandbox: SandboxHandle): Promise<void> => {
  for (let attempt = 0; attempt < CLEANUP_MAX_ATTEMPTS; attempt++) {
    try {
      await sandbox.kill();
      return;
    } catch (killError) {
      console.error(
        `[resolve-executor] sandbox.kill() attempt ${attempt + 1} failed: ${killError instanceof Error ? killError.message : String(killError)}`
      );
      if (attempt < CLEANUP_MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, CLEANUP_RETRY_DELAY_MS));
      }
    }
  }
  console.error(
    `[resolve-executor] Failed to kill sandbox ${sandbox.sandboxId} after ${CLEANUP_MAX_ATTEMPTS} attempts`
  );
};

const buildFailureResponse = (
  model: string,
  error: string
): ResolveResponse => ({
  success: false,
  patch: null,
  filesChanged: [],
  result: {
    model,
    iterations: 0,
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    finalMessage: "",
  },
  error,
});

const cloneRepo = async (
  sandbox: SandboxHandle,
  request: ResolveRequest,
  worktreePath: string
): Promise<void> => {
  console.log(
    `[resolve-executor] Sandbox ${sandbox.sandboxId} created, cloning repo`
  );

  // HACK: Shell injection prevented by SAFE_STRING_PATTERN and GITHUB_REPO_URL_PATTERN regex validation above
  const cloneCmd = `git clone --depth 1 --branch ${request.branch} ${request.repoUrl} ${worktreePath}`;
  const cloneResult = await sandbox.commands.run(cloneCmd, {
    timeoutMs: CLONE_TIMEOUT_MS,
  });

  if (cloneResult.exitCode !== 0) {
    throw new Error(`Clone failed: ${sanitizeForLogging(cloneResult.stderr)}`);
  }
};

const tryDisableNetwork = async (sandbox: SandboxHandle): Promise<void> => {
  if (!sandbox.disableNetwork) {
    return;
  }

  try {
    await sandbox.disableNetwork();
    console.log("[resolve-executor] Network disabled for sandbox");
  } catch {
    console.warn(
      "[resolve-executor] Could not disable network (provider may not support it)"
    );
  }
};

const runResolveLoop = async (
  sandbox: SandboxHandle,
  request: ResolveRequest,
  worktreePath: string
): Promise<ResolveResponse> => {
  const toolContext = createSandboxToolContext({
    sandbox,
    worktreePath,
    repoRoot: worktreePath,
    runId: request.resolveId,
  });

  const registry = createToolRegistry(toolContext);
  registry.registerAll(createSandboxTools(sandbox));

  const resolvedModel = resolveModel(request);
  const config = createConfig(
    resolvedModel,
    10,
    request.budgetPerRunUSD ?? 1.0,
    request.remainingMonthlyUSD ?? -1
  );

  const loop = new ResolveLoop(registry, config);

  console.log("[resolve-executor] Starting resolve loop");
  const resolveResult: ResolveResult = await loop.run(
    SYSTEM_PROMPT,
    request.userPrompt
  );

  console.log(
    `[resolve-executor] Resolve loop completed: success=${resolveResult.success}, iterations=${resolveResult.iterations}`
  );

  let patch: string | null = null;
  let filesChanged: string[] = [];

  if (resolveResult.success) {
    [patch, filesChanged] = await Promise.all([
      extractPatch(sandbox, worktreePath),
      extractFilesChanged(sandbox, worktreePath),
    ]);
    console.log(
      `[resolve-executor] Extracted patch with ${filesChanged.length} files changed`
    );
  }

  return {
    success: resolveResult.success,
    patch,
    filesChanged,
    result: {
      model: resolvedModel,
      iterations: resolveResult.iterations,
      costUSD: resolveResult.costUSD,
      inputTokens: resolveResult.inputTokens,
      outputTokens: resolveResult.outputTokens,
      finalMessage: resolveResult.finalMessage,
      commandLog: resolveResult.commandLog,
    },
  };
};

const parseResolveRequest = (
  rawRequest: unknown
): ResolveRequest | ResolveResponse => {
  const parseResult = resolveRequestSchema.safeParse(rawRequest);
  if (!parseResult.success) {
    const errors = parseResult.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return buildFailureResponse(
      DEFAULT_SMART_MODEL,
      `Invalid request: ${errors}`
    );
  }
  return {
    resolveId: parseResult.data.resolveId,
    repoUrl: parseResult.data.repoUrl,
    branch: parseResult.data.branch,
    userPrompt: parseResult.data.userPrompt,
    model: parseResult.data.model,
    budgetPerRunUSD: parseResult.data.budgetPerRunUSD,
    remainingMonthlyUSD: parseResult.data.remainingMonthlyUSD,
  };
};

const isFailureResponse = (
  value: ResolveRequest | ResolveResponse
): value is ResolveResponse => "success" in value;

const resolveModel = (request: ResolveRequest): string =>
  request.model ?? DEFAULT_SMART_MODEL;

const prepareSandbox = async (
  sandbox: SandboxHandle,
  request: ResolveRequest,
  worktreePath: string
): Promise<ResolveResponse | null> => {
  await cloneRepo(sandbox, request, worktreePath);

  console.log("[resolve-executor] Repo cloned, installing dependencies");

  try {
    await installDependencies(sandbox, worktreePath);
  } catch (installError) {
    const reason =
      installError instanceof Error
        ? installError.message
        : String(installError);
    console.error(`[resolve-executor] ${reason}`);
    return buildFailureResponse(resolveModel(request), reason);
  }

  await tryDisableNetwork(sandbox);
  return null;
};

export const executeResolve = async (
  appEnv: Env,
  rawRequest: unknown
): Promise<ResolveResponse> => {
  const requestOrError = parseResolveRequest(rawRequest);
  if (isFailureResponse(requestOrError)) {
    return requestOrError;
  }

  const request = requestOrError;
  let sandbox: SandboxHandle | null = null;
  const sandboxService = createSandboxService(appEnv);
  const worktreePath = `${sandboxService.rootPath}/repo`;

  try {
    console.log(
      `[resolve-executor] Creating sandbox for resolve ${request.resolveId}`
    );

    sandbox = await sandboxService.create({
      template: SANDBOX_TEMPLATE,
      timeout: SANDBOX_TIMEOUT_SEC,
      metadata: {
        resolveId: request.resolveId,
      },
    });

    const prepError = await prepareSandbox(sandbox, request, worktreePath);
    if (prepError) {
      return prepError;
    }

    return await runResolveLoop(sandbox, request, worktreePath);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = sanitizeForLogging(rawMessage);
    console.error(`[resolve-executor] Error: ${safeMessage}`);
    return buildFailureResponse(resolveModel(request), safeMessage);
  } finally {
    if (sandbox) {
      // HACK: fire-and-forget cleanup; no need to block the response
      cleanupSandbox(sandbox).catch((err) => {
        console.error(
          `[resolve-executor] Background sandbox cleanup failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }
};
