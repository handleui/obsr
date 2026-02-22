import { realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { errorResult, type ToolResult } from "./types.js";

export type CommandApprovalDecision = "allow" | "deny" | "always" | "never";

export interface FailingStep {
  jobId: string;
  stepIndex: number;
}

export interface ToolContext {
  worktreePath: string;
  repoRoot: string;
  runId: string;
  firstCommitSha?: string;
  approvedCommands: Set<string>;
  deniedCommands: Set<string>;
  commandChecker?: (cmd: string) => boolean;
  commandApprover?: (cmd: string) => Promise<CommandApprovalDecision>;
  commandPersister?: (cmd: string) => Promise<void>;
  stepCommands?: Map<string, (string | null)[]>;
  failingStep?: FailingStep;
}

export const createToolContext = (
  worktreePath: string,
  repoRoot: string,
  runId: string
): ToolContext => ({
  worktreePath,
  repoRoot,
  runId,
  approvedCommands: new Set(),
  deniedCommands: new Set(),
});

export const isCommandApproved = (ctx: ToolContext, cmd: string): boolean =>
  ctx.approvedCommands.has(cmd);

export const approveCommand = (ctx: ToolContext, cmd: string): void => {
  ctx.approvedCommands.add(cmd);
};

export const isCommandDenied = (ctx: ToolContext, cmd: string): boolean =>
  ctx.deniedCommands.has(cmd);

export const denyCommand = (ctx: ToolContext, cmd: string): void => {
  ctx.deniedCommands.add(cmd);
};

export interface PathValidationResult {
  valid: boolean;
  absPath?: string;
  error?: ToolResult;
}

export const validatePath = (
  ctx: ToolContext,
  relPath: string
): PathValidationResult => {
  const cleanPath = normalize(relPath);

  if (isAbsolute(cleanPath)) {
    return {
      valid: false,
      error: errorResult(`absolute paths not allowed: ${relPath}`),
    };
  }

  const absPath = join(ctx.worktreePath, cleanPath);

  const rel = relative(ctx.worktreePath, absPath);
  if (rel.startsWith("..")) {
    return {
      valid: false,
      error: errorResult(`path escapes worktree: ${relPath}`),
    };
  }

  try {
    const realWorktree = realpathSync(ctx.worktreePath);
    const realPath = realpathSync(absPath);
    const realRel = relative(realWorktree, realPath);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      return {
        valid: false,
        error: errorResult(`symlink escapes worktree: ${relPath}`),
      };
    }
  } catch {
    // Path doesn't exist yet, which is fine for write operations
  }

  return { valid: true, absPath };
};
