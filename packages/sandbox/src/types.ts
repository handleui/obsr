export type SandboxProviderName = "vercel" | "e2b";

export interface SandboxEnv {
  SANDBOX_PROVIDER?: string;
  E2B_API_KEY?: string;
  VERCEL_TOKEN?: string;
  VERCEL_TEAM_ID?: string;
  VERCEL_PROJECT_ID?: string;
}

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

export interface SandboxFileInfo {
  type: "file" | "dir";
}

export interface SandboxCommandExecution {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxCodeExecution {
  logs: {
    stdout: string[];
    stderr: string[];
  };
  text?: string | null;
  error?: { value?: string } | null;
}

export interface SandboxHandle {
  sandboxId: string;
  runCode: (
    code: string,
    opts?: { language?: string; timeoutMs?: number }
  ) => Promise<SandboxCodeExecution>;
  commands: {
    run: (
      command: string,
      opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number }
    ) => Promise<SandboxCommandExecution>;
  };
  files: {
    write: (path: string, content: string) => Promise<void>;
    read: (
      path: string,
      opts?: { format?: "text" | "binary" }
    ) => Promise<string | Uint8Array>;
    exists: (path: string) => Promise<boolean>;
    getInfo: (path: string) => Promise<SandboxFileInfo>;
  };
  kill: () => Promise<void>;
  setTimeout: (timeoutMs: number) => Promise<void>;
  isRunning: () => Promise<boolean>;
  disableNetwork?: () => Promise<void>;
}

export interface SandboxProvider {
  name: SandboxProviderName;
  create: (opts?: SandboxOptions) => Promise<SandboxHandle>;
  connect: (sandboxId: string) => Promise<SandboxHandle>;
  list: () => Promise<SandboxInfo[]>;
  isRateLimitError: (error: unknown) => boolean;
}
