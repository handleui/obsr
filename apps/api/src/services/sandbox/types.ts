/** Options for creating a new sandbox */
export interface SandboxOptions {
  /** E2B template ID (default: python-3.11) */
  template?: string;
  /** Sandbox timeout in seconds (default: 300, max: 3600 hobby / 86400 pro) */
  timeout?: number;
  /** Custom metadata for tracking (user_id, org_id, task_id, etc.) */
  metadata?: Record<string, string>;
  /** Environment variables to set in sandbox */
  envs?: Record<string, string>;
}

/** Options for code execution */
export interface RunCodeOptions {
  /** Language to execute (default: python) */
  language?: "python" | "ts" | "bash";
  /** Execution timeout in seconds */
  timeout?: number;
}

/** Options for command execution */
export interface RunCommandOptions {
  /** Working directory for command */
  cwd?: string;
  /** Environment variables for command */
  envs?: Record<string, string>;
  /** Command timeout in seconds */
  timeout?: number;
}

/** Result from code execution */
export interface CodeResult {
  /** Combined stdout/stderr logs */
  logs: string;
  /** Final expression result (if any) */
  text?: string;
  /** Error message (if execution failed) */
  error?: string;
}

/** Result from command execution */
export interface CommandResult {
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Exit code (0 = success) */
  exitCode: number;
}

/** Sandbox info for listing/tracking */
export interface SandboxInfo {
  /** Unique sandbox ID (for reconnection) */
  sandboxId: string;
  /** Template used to create sandbox */
  template: string;
  /** Custom metadata */
  metadata: Record<string, string>;
  /** Sandbox start time */
  startedAt?: Date;
}

/** Re-export Sandbox type for convenience */
export type { Sandbox } from "@e2b/code-interpreter";
