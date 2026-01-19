export interface SandboxOptions {
  template?: string;
  timeout?: number;
  metadata?: Record<string, string>;
  envs?: Record<string, string>;
}

export interface RunCodeOptions {
  language?: "python" | "ts" | "bash";
  timeout?: number;
}

export interface RunCommandOptions {
  cwd?: string;
  envs?: Record<string, string>;
  timeout?: number;
}

export interface CodeResult {
  logs: string;
  text?: string;
  error?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxInfo {
  sandboxId: string;
  template: string;
  metadata: Record<string, string>;
  startedAt?: Date;
}

export type { Sandbox } from "@e2b/code-interpreter";
