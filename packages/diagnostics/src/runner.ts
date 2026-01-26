import { spawn } from "node:child_process";
import { extract } from "./extract.js";
import { prepareCommand } from "./prepare.js";
import type { DiagnosticResult } from "./types.js";

const DEFAULT_MAX_BUFFER = 50 * 1024 * 1024;
const SIGKILL_GRACE_MS = 5000;

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  maxBuffer?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  diagnostics: DiagnosticResult;
  exitCode: number;
  timedOut: boolean;
  bufferExceeded: boolean;
  command: string;
}

const killWithEscalation = (child: ReturnType<typeof spawn>): (() => void) => {
  child.kill("SIGTERM");

  const killTimer = setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, SIGKILL_GRACE_MS);

  return () => clearTimeout(killTimer);
};

/**
 * Run a command and extract diagnostics from its output.
 *
 * - Automatically detects the tool and injects JSON output flags
 * - Executes the command and captures stdout/stderr
 * - Parses diagnostics from the appropriate output stream
 *
 * Security notes:
 * - Commands are executed with shell: true (required for script execution)
 * - Do NOT pass untrusted user input as the command string
 * - Buffer size is limited to prevent memory exhaustion (default 50MB)
 * - Processes are killed with SIGTERM, escalating to SIGKILL after 5s
 *
 * @example
 * ```ts
 * const result = await run("bun run test", { cwd: "/project" })
 * console.log(result.diagnostics.summary)
 * // { total: 5, errors: 3, warnings: 2 }
 * ```
 */
export const run = async (
  command: string,
  options?: RunOptions
): Promise<RunResult> => {
  const prepared = prepareCommand(command);
  const timeout = options?.timeout ?? 120_000;
  const maxBuffer = options?.maxBuffer ?? DEFAULT_MAX_BUFFER;

  const child = spawn(prepared.command, {
    shell: true,
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLength = 0;
  let stderrLength = 0;
  let timedOut = false;
  let bufferExceeded = false;
  let spawnErrorMessage: string | null = null;
  let cleanupKill: (() => void) | null = null;

  child.on("error", (err: Error) => {
    spawnErrorMessage = err.message;
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    if (bufferExceeded) {
      return;
    }
    if (stdoutLength + chunk.length > maxBuffer) {
      bufferExceeded = true;
      cleanupKill = killWithEscalation(child);
      return;
    }
    stdoutChunks.push(chunk);
    stdoutLength += chunk.length;
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (bufferExceeded) {
      return;
    }
    if (stderrLength + chunk.length > maxBuffer) {
      bufferExceeded = true;
      cleanupKill = killWithEscalation(child);
      return;
    }
    stderrChunks.push(chunk);
    stderrLength += chunk.length;
  });

  const timeoutId = setTimeout(() => {
    timedOut = true;
    cleanupKill = killWithEscalation(child);
  }, timeout);

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      cleanupKill?.();
      resolve(code ?? 1);
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString();
  let stderr = Buffer.concat(stderrChunks).toString();

  if (spawnErrorMessage) {
    stderr = `${spawnErrorMessage}\n${stderr}`;
  }

  const output = prepared.outputSource === "stdout" ? stdout : stderr;
  const diagnostics = extract(output, prepared.tool ?? undefined);

  return {
    stdout,
    stderr,
    diagnostics,
    exitCode,
    timedOut,
    bufferExceeded,
    command: prepared.command,
  };
};
