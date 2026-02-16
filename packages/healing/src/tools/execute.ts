import { spawn } from "node:child_process";
import { errorResult, type ToolResult } from "./types.js";

export const COMMAND_TIMEOUT = 5 * 60 * 1000;

export const MAX_OUTPUT = 50 * 1024;

export const BLOCKED_BYTES = [0x00, 0x0a, 0x0d];

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const COMMAND_PATTERNS = [
  "rm -rf",
  "rm -r",
  "sudo",
  "chmod",
  "chown",
  "curl",
  "wget",
  "git push",
  "git remote",
  "git config",
  "ssh",
  "scp",
  "nc ",
  "netcat",
  "eval",
  "exec",
];

// HACK: no trailing word boundary — -c/-e can be followed directly by code (e.g. `python -c'code'`)
const INLINE_EXEC_PATTERNS = [
  "python -c",
  "python3 -c",
  "ruby -e",
  "perl -e",
  "node -e",
  "node --eval",
  "bun -e",
];

const OPERATOR_PATTERNS = [
  ">>",
  "> ",
  ">",
  "|",
  "&&",
  "||",
  ";",
  "$(",
  "`",
  "${",
];

const COMMAND_PATTERN_REGEXES = COMMAND_PATTERNS.map(
  (p) => new RegExp(`(?:^|\\s)${escapeRegExp(p.trimEnd())}(?:\\s|$)`)
);

const INLINE_EXEC_REGEXES = INLINE_EXEC_PATTERNS.map(
  (p) => new RegExp(`(?:^|\\s)${escapeRegExp(p.trimEnd())}`)
);

export const BLOCKED_PATTERNS = [
  ...COMMAND_PATTERNS,
  ...INLINE_EXEC_PATTERNS,
  ...OPERATOR_PATTERNS,
];

export const BLOCKED_COMMANDS = new Set([
  "rm",
  "sudo",
  "chmod",
  "chown",
  "curl",
  "wget",
  "ssh",
  "scp",
  "nc",
  "netcat",
  "eval",
  "exec",
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "env",
  "xargs",
  "nohup",
  "strace",
  "ltrace",
  "dd",
  "mkfs",
  "mount",
  "umount",
  "kill",
  "killall",
  "pkill",
  "reboot",
  "shutdown",
  "poweroff",
  "crontab",
  "at",
  "ncat",
  "socat",
  "telnet",
  "ftp",
  "sftp",
  "rsync",
]);

export const ALLOWED_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "CGO_ENABLED",
  "NODE_ENV",
  "NODE_PATH",
  "NPM_CONFIG_CACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "JAVA_HOME",
  "MAVEN_HOME",
  "GRADLE_HOME",
]);

export const BLOCKED_ENV_SUFFIXES = [
  "_KEY",
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
  "_CREDS",
  "_AUTH",
  "_API",
  "_APIKEY",
  "_BEARER",
  "_OAUTH",
  "_REFRESH",
  "_SESSION",
  "_PRIVATE",
  "_CREDENTIAL",
  "_CREDENTIALS",
];

export interface ExecuteMetadata extends Record<string, unknown> {
  exitCode: number;
  timedOut: boolean;
}

const WHITESPACE_REGEX = /\s+/;

export const normalizeCommand = (cmd: string): string =>
  cmd.split(WHITESPACE_REGEX).join(" ");

export const extractBaseCommand = (cmd: string): string => {
  const lastSlash = cmd.lastIndexOf("/");
  return lastSlash >= 0 ? cmd.slice(lastSlash + 1) : cmd;
};

const isBlockedCodePoint = (code: number): boolean =>
  // C0 controls except tab (0x09)
  (code < 0x20 && code !== 0x09) ||
  // DEL + C1 controls
  (code >= 0x7f && code <= 0x9f) ||
  // Invisible/formatting Unicode (spaces, zero-width, bidi controls)
  code === 0xa0 ||
  code === 0xad ||
  code === 0x16_80 ||
  (code >= 0x20_00 && code <= 0x20_0f) ||
  (code >= 0x20_28 && code <= 0x20_2f) ||
  (code >= 0x20_5f && code <= 0x20_64) ||
  (code >= 0x20_66 && code <= 0x20_6f) ||
  code === 0x30_00 ||
  code === 0xfe_ff ||
  (code >= 0xff_f9 && code <= 0xff_fb);

export const hasBlockedBytes = (cmd: string): boolean => {
  for (let i = 0; i < cmd.length; i++) {
    const code = cmd.charCodeAt(i);
    if (isBlockedCodePoint(code)) {
      return true;
    }
  }
  return false;
};

export const hasBlockedPattern = (normalizedCmd: string): string | null => {
  for (let i = 0; i < COMMAND_PATTERNS.length; i++) {
    if ((COMMAND_PATTERN_REGEXES[i] as RegExp).test(normalizedCmd)) {
      return COMMAND_PATTERNS[i] as string;
    }
  }
  for (let i = 0; i < INLINE_EXEC_PATTERNS.length; i++) {
    if ((INLINE_EXEC_REGEXES[i] as RegExp).test(normalizedCmd)) {
      return INLINE_EXEC_PATTERNS[i] as string;
    }
  }
  for (const pattern of OPERATOR_PATTERNS) {
    if (normalizedCmd.includes(pattern)) {
      return pattern;
    }
  }
  return null;
};

// HACK: cached — process.env is stable during a heal session, no need to rebuild per command
let cachedSafeEnv: Record<string, string> | null = null;

export const resetSafeEnvCache = (): void => {
  cachedSafeEnv = null;
};

export const createSafeEnv = (): Record<string, string> => {
  if (cachedSafeEnv) {
    return cachedSafeEnv;
  }

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }

    const upperKey = key.toUpperCase();
    const isBlocked = BLOCKED_ENV_SUFFIXES.some((suffix) =>
      upperKey.endsWith(suffix)
    );

    if (isBlocked) {
      continue;
    }

    if (ALLOWED_ENV_VARS.has(key)) {
      env[key] = value;
    }
  }

  cachedSafeEnv = env;
  return env;
};

export const validateCommand = (command: string): string | null => {
  if (hasBlockedBytes(command)) {
    return "command contains invalid characters";
  }

  const normalizedCmd = normalizeCommand(command);
  const blockedPattern = hasBlockedPattern(normalizedCmd);
  if (blockedPattern) {
    return `blocked pattern: "${blockedPattern}"`;
  }

  const parts = normalizedCmd.split(" ").filter(Boolean);
  if (parts.length === 0 || parts[0] === undefined) {
    return "empty command";
  }

  const baseCmd = extractBaseCommand(parts[0]);
  if (BLOCKED_COMMANDS.has(baseCmd)) {
    return `blocked command: "${baseCmd}"`;
  }

  return null;
};

export const parseCommand = (
  command: string
): { normalized: string; parts: string[] } => {
  const normalized = normalizeCommand(command);
  const parts = normalized.split(" ").filter(Boolean);
  return { normalized, parts };
};

const truncateOutput = (buffer: string): string =>
  buffer.length > MAX_OUTPUT
    ? `${buffer.slice(0, MAX_OUTPUT)}\n... (truncated)`
    : buffer;

const buildExecuteResult = (
  content: string,
  isError: boolean,
  exitCode: number,
  timedOut: boolean
): ToolResult => ({
  content,
  isError,
  metadata: { exitCode, timedOut } as ExecuteMetadata,
});

const formatHeader = (fullCmd: string, startTime: number): string =>
  `$ ${fullCmd}\n(completed in ${Date.now() - startTime}ms)\n\n`;

const resolveClose = (
  code: number | null,
  timedOut: boolean,
  stdout: string,
  stderr: string,
  fullCmd: string,
  startTime: number
): ToolResult => {
  const header = formatHeader(fullCmd, startTime);
  const output = stdout + stderr;

  if (timedOut) {
    return buildExecuteResult(
      `${header}TIMEOUT: exceeded 5 minutes\n`,
      true,
      -1,
      true
    );
  }

  const exitCode = code ?? 0;
  if (exitCode !== 0) {
    return buildExecuteResult(
      `${header}Exit code: ${exitCode}\n\n${output}`,
      true,
      exitCode,
      false
    );
  }

  return buildExecuteResult(`${header}${output}`, false, 0, false);
};

export const executeCommand = (
  cwd: string,
  fullCmd: string,
  parts: string[],
  abortSignal?: AbortSignal
): Promise<ToolResult> => {
  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const [command, ...args] = parts;

  if (command === undefined) {
    return Promise.resolve(errorResult("empty command"));
  }

  if (abortSignal?.aborted) {
    return Promise.resolve(errorResult("command aborted before execution"));
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: createSafeEnv(),
      timeout: COMMAND_TIMEOUT,
      signal: abortSignal,
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT);

    child.stdout.on("data", (data: Buffer) => {
      stdout = truncateOutput(stdout + data.toString());
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr = truncateOutput(stderr + data.toString());
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      resolve(resolveClose(code, timedOut, stdout, stderr, fullCmd, startTime));
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      const header = formatHeader(fullCmd, startTime);
      resolve(
        buildExecuteResult(`${header}Error: ${err.message}\n`, true, -1, false)
      );
    });
  });
};
