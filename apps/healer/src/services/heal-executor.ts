import {
  Client,
  createConfig,
  createToolRegistry,
  HealLoop,
  type HealResult,
  SYSTEM_PROMPT,
} from "@detent/healing";
import { Sandbox } from "@e2b/code-interpreter";
import { z } from "zod";
import {
  createSandboxToolContext,
  createSandboxTools,
} from "../adapters/sandbox-tools.js";
import type { Env } from "../env.js";

const SANDBOX_TEMPLATE = "base";
const SANDBOX_TIMEOUT_SEC = 600;
const WORKTREE_PATH = "/home/user/repo";
const CLONE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000;
const DEFAULT_MODEL = "openai/gpt-5.2-codex";

const MAX_HEAL_ID_LENGTH = 64;
const MAX_BRANCH_LENGTH = 256;
const MAX_REPO_URL_LENGTH = 2048;
const MAX_PROMPT_LENGTH = 100_000;

const SAFE_STRING_PATTERN = /^[a-zA-Z0-9_\-./]+$/;

const GITHUB_REPO_URL_PATTERN =
  /^https:\/\/(x-access-token:[^@]+@)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\.git$/;

const healRequestSchema = z.object({
  healId: z
    .string()
    .min(1)
    .max(MAX_HEAL_ID_LENGTH)
    .regex(SAFE_STRING_PATTERN, "Invalid heal ID format"),
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
  budgetPerRunUSD: z.number().positive().max(100).optional(),
  remainingMonthlyUSD: z.number().optional(),
});

export type HealRequest = z.infer<typeof healRequestSchema>;

interface HealResponse {
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
  };
  error?: string;
}

const detectPackageManager = async (
  sandbox: Sandbox
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
      exists: await sandbox.files.exists(`${WORKTREE_PATH}/${file}`),
    }))
  );

  for (const { manager, exists } of checks) {
    if (exists) {
      return manager;
    }
  }

  const hasPackageJson = await sandbox.files.exists(
    `${WORKTREE_PATH}/package.json`
  );
  return hasPackageJson ? "npm" : null;
};

const installDependencies = async (sandbox: Sandbox): Promise<void> => {
  const manager = await detectPackageManager(sandbox);
  if (!manager) {
    return;
  }

  const installCmd =
    manager === "npm" ? "npm ci --prefer-offline" : `${manager} install`;

  console.log(`[heal-executor] Installing dependencies with ${manager}`);

  const result = await sandbox.commands.run(installCmd, {
    cwd: WORKTREE_PATH,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    console.warn(
      `[heal-executor] Dependency install exited with ${result.exitCode}: ${result.stderr}`
    );
  }
};

const extractPatch = async (sandbox: Sandbox): Promise<string | null> => {
  const result = await sandbox.commands.run("git diff", {
    cwd: WORKTREE_PATH,
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    console.error(`[heal-executor] git diff failed: ${result.stderr}`);
    return null;
  }

  const patch = result.stdout.trim();
  return patch === "" ? null : patch;
};

const extractFilesChanged = async (sandbox: Sandbox): Promise<string[]> => {
  const result = await sandbox.commands.run("git diff --name-only", {
    cwd: WORKTREE_PATH,
    timeoutMs: 30_000,
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

export const executeHeal = async (
  appEnv: Env,
  rawRequest: unknown
): Promise<HealResponse> => {
  let resolvedModel = DEFAULT_MODEL;
  const parseResult = healRequestSchema.safeParse(rawRequest);
  if (!parseResult.success) {
    const errors = parseResult.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return {
      success: false,
      patch: null,
      filesChanged: [],
      result: {
        model: resolvedModel,
        iterations: 0,
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        finalMessage: "",
      },
      error: `Invalid request: ${errors}`,
    };
  }

  const request = parseResult.data;
  let sandbox: Sandbox | null = null;

  try {
    console.log(`[heal-executor] Creating sandbox for heal ${request.healId}`);

    sandbox = await Sandbox.create(SANDBOX_TEMPLATE, {
      apiKey: appEnv.E2B_API_KEY,
      timeoutMs: SANDBOX_TIMEOUT_SEC * 1000,
      metadata: { healId: request.healId },
    });

    console.log(
      `[heal-executor] Sandbox ${sandbox.sandboxId} created, cloning repo`
    );

    // SECURITY: Shell injection is prevented by strict regex validation:
    // - branch: SAFE_STRING_PATTERN allows only [a-zA-Z0-9_\-./]
    // - repoUrl: GITHUB_REPO_URL_PATTERN requires exact GitHub URL format
    // These patterns explicitly disallow shell metacharacters ($, `, ;, |, &, etc.)
    const cloneCmd = `git clone --depth 1 --branch ${request.branch} ${request.repoUrl} ${WORKTREE_PATH}`;
    const cloneResult = await sandbox.commands.run(cloneCmd, {
      timeoutMs: CLONE_TIMEOUT_MS,
    });

    if (cloneResult.exitCode !== 0) {
      throw new Error(
        `Clone failed: ${sanitizeForLogging(cloneResult.stderr)}`
      );
    }

    console.log("[heal-executor] Repo cloned, installing dependencies");
    await installDependencies(sandbox);

    const toolContext = createSandboxToolContext({
      sandbox,
      worktreePath: WORKTREE_PATH,
      repoRoot: WORKTREE_PATH,
      runId: request.healId,
    });

    const registry = createToolRegistry(toolContext);
    registry.registerAll(createSandboxTools(sandbox));

    const client = new Client(appEnv.AI_GATEWAY_API_KEY);

    const config = createConfig(
      DEFAULT_MODEL,
      10,
      request.budgetPerRunUSD ?? 1.0,
      request.remainingMonthlyUSD ?? -1
    );
    resolvedModel = client.normalizeModel(config.model);

    const loop = new HealLoop(client, registry, config);

    console.log("[heal-executor] Starting heal loop");
    const healResult: HealResult = await loop.run(
      SYSTEM_PROMPT,
      request.userPrompt
    );

    console.log(
      `[heal-executor] Heal loop completed: success=${healResult.success}, iterations=${healResult.iterations}`
    );

    let patch: string | null = null;
    let filesChanged: string[] = [];

    if (healResult.success) {
      [patch, filesChanged] = await Promise.all([
        extractPatch(sandbox),
        extractFilesChanged(sandbox),
      ]);
      console.log(
        `[heal-executor] Extracted patch with ${filesChanged.length} files changed`
      );
    }

    return {
      success: healResult.success,
      patch,
      filesChanged,
      result: {
        model: resolvedModel,
        iterations: healResult.iterations,
        costUSD: healResult.costUSD,
        inputTokens: healResult.inputTokens,
        outputTokens: healResult.outputTokens,
        finalMessage: healResult.finalMessage,
      },
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = sanitizeForLogging(rawMessage);
    console.error(`[heal-executor] Error: ${safeMessage}`);

    return {
      success: false,
      patch: null,
      filesChanged: [],
      result: {
        model: resolvedModel,
        iterations: 0,
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        finalMessage: "",
      },
      error: safeMessage,
    };
  } finally {
    if (sandbox) {
      try {
        console.log(`[heal-executor] Killing sandbox ${sandbox.sandboxId}`);
        await sandbox.kill();
      } catch (killError) {
        console.error(
          `[heal-executor] Failed to kill sandbox: ${killError instanceof Error ? killError.message : String(killError)}`
        );
      }
    }
  }
};
