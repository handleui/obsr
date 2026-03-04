import {
  BLOCKED_COMMANDS,
  type CommandApprovalDecision,
  errorResult,
  extractBaseCommand,
  type FailingStep,
  hasBlockedBytes,
  hasBlockedPattern,
  normalizeCommand,
  SchemaBuilder,
  successResult,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@detent/resolving/tools";
import type { SandboxHandle } from "../services/sandbox/index.js";

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_READ_LIMIT = 10_000;
const MAX_OFFSET = 1_000_000;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_OUTPUT = 50 * 1024;
const MAX_GREP_MATCHES = 100;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const LEADING_DOT_SLASH_REGEX = /^\.\//;

interface SandboxToolContextOpts {
  sandbox: SandboxHandle;
  worktreePath: string;
  repoRoot: string;
  runId: string;
  firstCommitSha?: string;
  stepCommands?: Map<string, (string | null)[]>;
  failingStep?: FailingStep;
  commandChecker?: (cmd: string) => boolean;
  commandApprover?: (cmd: string) => Promise<CommandApprovalDecision>;
  commandPersister?: (cmd: string) => Promise<void>;
}

interface SandboxToolContext extends ToolContext {
  sandbox: SandboxHandle;
}

export const createSandboxToolContext = (
  opts: SandboxToolContextOpts
): SandboxToolContext => ({
  sandbox: opts.sandbox,
  worktreePath: opts.worktreePath,
  repoRoot: opts.repoRoot,
  runId: opts.runId,
  firstCommitSha: opts.firstCommitSha,
  approvedCommands: new Set(),
  deniedCommands: new Set(),
  commandChecker: opts.commandChecker,
  commandApprover: opts.commandApprover,
  commandPersister: opts.commandPersister,
  stepCommands: opts.stepCommands,
  failingStep: opts.failingStep,
});

interface PathValidation {
  valid: boolean;
  absPath?: string;
  error?: ToolResult;
}

// SECURITY: Reject shell metacharacters in paths to prevent injection even if quoting is bypassed
const SHELL_META_CHARS = /[`$\\!#&|;(){}<>*?~\n\r]/;

const validateSandboxPath = (
  worktreePath: string,
  relPath: string
): PathValidation => {
  if (relPath.includes("\0")) {
    return {
      valid: false,
      error: errorResult("path contains null byte"),
    };
  }

  if (SHELL_META_CHARS.test(relPath)) {
    return {
      valid: false,
      error: errorResult("path contains invalid characters"),
    };
  }

  const cleanPath = relPath.replace(LEADING_DOT_SLASH_REGEX, "");

  if (cleanPath.startsWith("/")) {
    return {
      valid: false,
      error: errorResult(`absolute paths not allowed: ${relPath}`),
    };
  }

  if (cleanPath.includes("..")) {
    return {
      valid: false,
      error: errorResult(`path escapes worktree: ${relPath}`),
    };
  }

  const absPath = `${worktreePath}/${cleanPath}`.replace(/\/+/g, "/");

  return { valid: true, absPath };
};

const validateRequiredString = (
  value: unknown,
  name: string
): ToolResult | null => {
  if (!value || typeof value !== "string") {
    return errorResult(`invalid input: ${name} is required`);
  }
  if (value === "") {
    return errorResult(`${name} is required`);
  }
  return null;
};

const validateReadParams = (
  offset: number,
  limit: number
): ToolResult | null => {
  if (offset < 1) {
    return errorResult("offset must be at least 1");
  }
  if (offset > MAX_OFFSET) {
    return errorResult(`offset must not exceed ${MAX_OFFSET}`);
  }
  if (limit < 1) {
    return errorResult("limit must be at least 1");
  }
  if (limit > MAX_READ_LIMIT) {
    return errorResult(`limit must not exceed ${MAX_READ_LIMIT}`);
  }
  return null;
};

const resolveSandboxSymlinks = async (
  sandbox: SandboxHandle,
  absPath: string,
  worktreePath: string,
  relPath: string
): Promise<ToolResult | null> => {
  try {
    const escapedPath = absPath.replace(/'/g, "'\\''");
    const result = await sandbox.commands.run(
      `timeout 0.5 readlink -f '${escapedPath}'`,
      { timeoutMs: 5000 }
    );
    if (result.exitCode !== 0) {
      return null;
    }
    const resolvedPath = result.stdout.trim();
    if (resolvedPath !== "" && !resolvedPath.startsWith(worktreePath)) {
      return errorResult(`symlink escapes worktree: ${relPath}`);
    }
  } catch {
    // HACK: readlink may fail for non-existent paths during write ops
  }
  return null;
};

const getValidatedPathAsync = async (
  sandbox: SandboxHandle,
  ctx: ToolContext,
  filePath: string
): Promise<ToolResult | string> => {
  const validation = validateSandboxPath(ctx.worktreePath, filePath);
  if (!(validation.valid && validation.absPath)) {
    return validation.error ?? errorResult("invalid path");
  }

  const symlinkError = await resolveSandboxSymlinks(
    sandbox,
    validation.absPath,
    ctx.worktreePath,
    filePath
  );
  if (symlinkError) {
    return symlinkError;
  }

  return validation.absPath;
};

const getSearchPathAsync = async (
  sandbox: SandboxHandle,
  ctx: ToolContext,
  searchDir?: string
): Promise<ToolResult | string> => {
  if (!searchDir) {
    return ctx.worktreePath;
  }
  return await getValidatedPathAsync(sandbox, ctx, searchDir);
};

const checkFileExists = async (
  sandbox: SandboxHandle,
  absPath: string,
  filePath: string
): Promise<ToolResult | null> => {
  const exists = await sandbox.files.exists(absPath);
  if (!exists) {
    return errorResult(`file not found: ${filePath}`);
  }
  const info = await sandbox.files.getInfo(absPath);
  if (info.type === "dir") {
    return errorResult(`path is a directory: ${filePath}`);
  }
  return null;
};

const formatLinesWithNumbers = (
  content: string,
  offset: number,
  limit: number
): { lines: string[]; totalLines: number; truncated: boolean } => {
  const allLines = content.split("\n");
  const totalLines = allLines.length;

  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, allLines.length);
  const selectedLines = allLines.slice(startIdx, endIdx);

  const formattedLines = selectedLines.map((line, idx) => {
    const lineNum = startIdx + idx + 1;
    let processedLine = line;
    if (processedLine.length > MAX_LINE_LENGTH) {
      processedLine = `${processedLine.slice(0, MAX_LINE_LENGTH)}...`;
    }
    return `${String(lineNum).padStart(6, " ")}\t${processedLine}`;
  });

  return {
    lines: formattedLines,
    totalLines,
    truncated: endIdx < allLines.length,
  };
};

const toText = (content: string | Uint8Array): string =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

export const createSandboxReadFileTool = (sandbox: SandboxHandle): Tool => ({
  name: "read_file",
  description:
    "Read a file from the codebase. Returns file contents with line numbers. Use offset and limit for large files.",
  inputSchema: new SchemaBuilder()
    .addString("path", "File path relative to repository root")
    .addOptionalInteger(
      "offset",
      "Line number to start reading from (1-indexed, default: 1)",
      1
    )
    .addOptionalInteger(
      "limit",
      "Maximum number of lines to read (default: 2000)",
      DEFAULT_READ_LIMIT
    )
    .build(),

  execute: async (ctx: ToolContext, input: unknown): Promise<ToolResult> => {
    const {
      path: filePath,
      offset = 1,
      limit = DEFAULT_READ_LIMIT,
    } = input as {
      path: string;
      offset?: number;
      limit?: number;
    };

    const pathError = validateRequiredString(filePath, "path");
    if (pathError) {
      return pathError;
    }

    const paramsError = validateReadParams(offset, limit);
    if (paramsError) {
      return paramsError;
    }

    const absPathOrError = await getValidatedPathAsync(sandbox, ctx, filePath);
    if (typeof absPathOrError !== "string") {
      return absPathOrError;
    }

    try {
      const fileError = await checkFileExists(
        sandbox,
        absPathOrError,
        filePath
      );
      if (fileError) {
        return fileError;
      }

      const rawContent = await sandbox.files.read(absPathOrError, {
        format: "text",
      });
      const content = toText(rawContent);

      if (content === "") {
        return successResult("(empty file)");
      }

      const { lines, totalLines, truncated } = formatLinesWithNumbers(
        content,
        offset,
        limit
      );

      if (lines.length === 0) {
        return errorResult(
          `offset ${offset} exceeds file length (${totalLines} lines)`
        );
      }

      let result = lines.join("\n");
      if (truncated) {
        result += `\n\n... (truncated at ${limit} lines, use offset to read more)`;
      }

      return successResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`failed to read file: ${message}`);
    }
  },
});

const countOccurrences = (text: string, search: string): number => {
  let count = 0;
  let pos = 0;
  let foundPos = text.indexOf(search, pos);
  while (foundPos !== -1) {
    count++;
    pos = foundPos + search.length;
    foundPos = text.indexOf(search, pos);
  }
  return count;
};

const countLines = (text: string): number => {
  if (text === "") {
    return 0;
  }
  return text.split("\n").length;
};

const validateEditInputs = (
  filePath: unknown,
  oldString: unknown,
  newString: unknown
): ToolResult | null => {
  if (
    !filePath ||
    typeof filePath !== "string" ||
    typeof oldString !== "string" ||
    typeof newString !== "string"
  ) {
    return errorResult(
      "invalid input: path, old_string, and new_string are required"
    );
  }
  if (filePath === "") {
    return errorResult("path is required");
  }
  if (oldString === "") {
    return errorResult("old_string is required");
  }
  if (oldString === newString) {
    return errorResult("old_string and new_string are identical");
  }
  return null;
};

const formatEditSummary = (oldLines: number, newLines: number): string => {
  if (oldLines === newLines) {
    return `replaced ${oldLines} line(s)`;
  }
  if (newLines > oldLines) {
    return `replaced ${oldLines} line(s) with ${newLines} line(s) (+${newLines - oldLines})`;
  }
  return `replaced ${oldLines} line(s) with ${newLines} line(s) (-${oldLines - newLines})`;
};

export const createSandboxEditFileTool = (sandbox: SandboxHandle): Tool => ({
  name: "edit_file",
  description:
    "Replace a string in a file. The old_string must match exactly once in the file (for safety). Use read_file first to see the exact content.",
  inputSchema: new SchemaBuilder()
    .addString("path", "File path relative to repository root")
    .addString(
      "old_string",
      "Exact string to find and replace (must be unique in file)"
    )
    .addString("new_string", "String to replace it with")
    .build(),

  execute: async (ctx: ToolContext, input: unknown): Promise<ToolResult> => {
    const {
      path: filePath,
      old_string: oldString,
      new_string: newString,
    } = input as {
      path: string;
      old_string: string;
      new_string: string;
    };

    const inputError = validateEditInputs(filePath, oldString, newString);
    if (inputError) {
      return inputError;
    }

    if (typeof newString === "string" && newString.includes("\0")) {
      return errorResult("new_string contains null byte");
    }

    const absPathOrError = await getValidatedPathAsync(sandbox, ctx, filePath);
    if (typeof absPathOrError !== "string") {
      return absPathOrError;
    }

    try {
      const fileError = await checkFileExists(
        sandbox,
        absPathOrError,
        filePath
      );
      if (fileError) {
        return fileError;
      }

      const rawContent = await sandbox.files.read(absPathOrError, {
        format: "text",
      });
      const content = toText(rawContent);

      const occurrences = countOccurrences(content, oldString);

      if (occurrences === 0) {
        return errorResult(
          "old_string not found in file. Use read_file to see exact content."
        );
      }

      if (occurrences > 1) {
        return errorResult(
          `old_string found ${occurrences} times in file (must be unique). Include more context to make it unique.`
        );
      }

      const newContent = content.replace(oldString, newString);
      await sandbox.files.write(absPathOrError, newContent);

      const summary = formatEditSummary(
        countLines(oldString),
        countLines(newString)
      );
      return successResult(`file updated: ${filePath} (${summary})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`failed to edit file: ${message}`);
    }
  },
});

const formatGlobOutput = (files: string[], pattern: string): string => {
  if (files.length === 0) {
    return `no files match pattern: ${pattern}`;
  }

  const truncated = files.length > MAX_GLOB_RESULTS;
  const results = truncated ? files.slice(0, MAX_GLOB_RESULTS) : files;

  let output = results.join("\n");
  if (truncated) {
    output +=
      "\n\n... (showing first 200 results, refine your pattern for more specific matches)";
  }

  return output;
};

export const createSandboxGlobTool = (sandbox: SandboxHandle): Tool => ({
  name: "glob",
  description:
    "Find files matching a glob pattern. Supports ** for recursive matching. Returns file paths sorted by modification time (newest first).",
  inputSchema: new SchemaBuilder()
    .addString(
      "pattern",
      "Glob pattern to match (e.g., '**/*.go', 'src/**/*.ts')"
    )
    .addOptionalString(
      "path",
      "Directory to search in (relative to repo root, default: root)"
    )
    .build(),

  execute: async (ctx: ToolContext, input: unknown): Promise<ToolResult> => {
    const { pattern, path: searchDir } = input as {
      pattern: string;
      path?: string;
    };

    const patternError = validateRequiredString(pattern, "pattern");
    if (patternError) {
      return patternError;
    }

    if (hasBlockedBytes(pattern)) {
      return errorResult("pattern contains invalid characters");
    }

    const searchPathOrError = await getSearchPathAsync(sandbox, ctx, searchDir);
    if (typeof searchPathOrError !== "string") {
      return searchPathOrError;
    }

    try {
      const escapedPattern = pattern
        .replace(/\*\*/g, "*")
        .replace(/'/g, "'\\''");
      const escapedSearchPath = searchPathOrError.replace(/'/g, "'\\''");
      const findCmd = `find '${escapedSearchPath}' -type f -name '${escapedPattern}' 2>/dev/null | head -${MAX_GLOB_RESULTS + 1}`;
      const result = await sandbox.commands.run(findCmd, {
        cwd: searchPathOrError,
        timeoutMs: 30_000,
      });

      if (result.exitCode !== 0 && result.stderr) {
        return errorResult(`glob failed: ${result.stderr}`);
      }

      const files = result.stdout
        .split("\n")
        .filter((f) => f.trim() !== "")
        .map((f) => f.replace(`${ctx.worktreePath}/`, ""));

      return successResult(formatGlobOutput(files, pattern));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`glob failed: ${message}`);
    }
  },
});

const FILE_TYPE_MAP: Record<string, string> = {
  go: "*.go",
  ts: "*.ts",
  typescript: "*.ts",
  js: "*.js",
  javascript: "*.js",
  py: "*.py",
  python: "*.py",
  rust: "*.rs",
  rs: "*.rs",
  java: "*.java",
  c: "*.c",
  cpp: "*.cpp",
  css: "*.css",
  html: "*.html",
  json: "*.json",
  yaml: "*.yaml",
  yml: "*.yaml",
  md: "*.md",
  markdown: "*.md",
};

const getFileTypeIncludeArg = (fileType?: string): ToolResult | string => {
  if (!fileType) {
    return "";
  }

  const globPattern = FILE_TYPE_MAP[fileType.toLowerCase()];
  if (!globPattern) {
    const supported = Object.keys(FILE_TYPE_MAP).slice(0, 10).join(", ");
    return errorResult(
      `unknown file type: ${fileType} (supported: ${supported}, ...)`
    );
  }

  return `--include="${globPattern}"`;
};

const processGrepOutput = (stdout: string, worktreePath: string): string => {
  let output = stdout;

  if (output.length > MAX_GREP_OUTPUT) {
    output = `${output.slice(0, MAX_GREP_OUTPUT)}\n... (truncated, refine your pattern for more specific matches)`;
  }

  return output.replaceAll(`${worktreePath}/`, "");
};

export const createSandboxGrepTool = (sandbox: SandboxHandle): Tool => ({
  name: "grep",
  description:
    "Search for a pattern in code using grep. Returns matching lines with file paths and line numbers.",
  inputSchema: new SchemaBuilder()
    .addString("pattern", "Regular expression pattern to search for")
    .addOptionalString(
      "path",
      "Directory or file to search in (relative to repo root, default: entire repo)"
    )
    .addOptionalString(
      "type",
      "File type filter (e.g., 'go', 'ts', 'py', 'rust', 'js')"
    )
    .build(),

  execute: async (ctx: ToolContext, input: unknown): Promise<ToolResult> => {
    const {
      pattern,
      path: searchDir,
      type: fileType,
    } = input as {
      pattern: string;
      path?: string;
      type?: string;
    };

    const patternError = validateRequiredString(pattern, "pattern");
    if (patternError) {
      return patternError;
    }

    if (hasBlockedBytes(pattern)) {
      return errorResult("pattern contains invalid characters");
    }

    const searchPathOrError = await getSearchPathAsync(sandbox, ctx, searchDir);
    if (typeof searchPathOrError !== "string") {
      return searchPathOrError;
    }

    const includeArgOrError = getFileTypeIncludeArg(fileType);
    if (typeof includeArgOrError !== "string") {
      return includeArgOrError;
    }

    try {
      const escapedPattern = pattern.replace(/'/g, "'\\''");
      const escapedSearchPath = searchPathOrError.replace(/'/g, "'\\''");
      const grepCmd = `grep -rn ${includeArgOrError} -m ${MAX_GREP_MATCHES} -E '${escapedPattern}' '${escapedSearchPath}' 2>/dev/null | head -c ${MAX_GREP_OUTPUT}`;

      const result = await sandbox.commands.run(grepCmd, {
        cwd: ctx.worktreePath,
        timeoutMs: 30_000,
      });

      if (result.exitCode === 1 && result.stdout === "") {
        return successResult(`no matches found for pattern: ${pattern}`);
      }

      if (result.exitCode === 2) {
        return errorResult(`grep error: ${result.stderr}`);
      }

      const output = processGrepOutput(result.stdout, ctx.worktreePath);
      return successResult(output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`grep failed: ${message}`);
    }
  },
});

const SAFE_COMMANDS: Record<string, string[] | null> = {
  go: ["build", "test", "fmt", "vet", "mod", "generate", "install", "run"],
  "golangci-lint": ["run"],
  gofumpt: null,
  goimports: null,
  staticcheck: null,
  govulncheck: null,
  npm: ["install", "ci", "test", "run"],
  yarn: ["install", "test", "run"],
  pnpm: ["install", "test", "run"],
  bun: ["install", "test", "run", "x"],
  npx: null,
  bunx: null,
  cargo: ["build", "test", "check", "fmt", "clippy", "run"],
  rustfmt: null,
  python: ["-m"],
  python3: ["-m"],
  pip: ["install"],
  pip3: ["install"],
  pytest: null,
  mypy: null,
  ruff: ["check", "format"],
  black: null,
  eslint: null,
  prettier: null,
  tsc: null,
  biome: ["check", "format", "lint"],
};

const SAFE_NPX_COMMANDS = new Set([
  "eslint",
  "prettier",
  "biome",
  "oxlint",
  "tsc",
  "tsc-watch",
  "vitest",
  "jest",
  "turbo",
  "nx",
]);

const isSafeCommand = (baseCmd: string, subCmd: string): boolean => {
  const actualBase = extractBaseCommand(baseCmd);
  const allowedSubs = SAFE_COMMANDS[actualBase];

  if (allowedSubs === undefined) {
    return false;
  }

  if (allowedSubs === null) {
    if (actualBase === "npx" || actualBase === "bunx") {
      return SAFE_NPX_COMMANDS.has(subCmd);
    }
    return true;
  }

  return allowedSubs.includes(subCmd);
};

const isCommandAllowed = async (
  ctx: ToolContext,
  fullCmd: string,
  parts: string[]
): Promise<boolean> => {
  const baseCmd = parts[0];
  const subCmd = parts[1] ?? "";

  if (baseCmd === undefined) {
    return false;
  }

  if (isSafeCommand(baseCmd, subCmd)) {
    return true;
  }

  if (ctx.commandChecker?.(fullCmd)) {
    return true;
  }

  if (ctx.approvedCommands.has(fullCmd)) {
    return true;
  }

  if (ctx.deniedCommands.has(fullCmd)) {
    return false;
  }

  if (ctx.commandApprover) {
    const decision = await ctx.commandApprover(fullCmd);

    if (decision === "deny" || decision === "never") {
      ctx.deniedCommands.add(fullCmd);
      return false;
    }

    if (decision === "always" && ctx.commandPersister) {
      try {
        await ctx.commandPersister(fullCmd);
      } catch {
        // HACK: best-effort persist — approval still granted even if storage fails
      }
    }

    ctx.approvedCommands.add(fullCmd);
    return true;
  }

  return false;
};

interface CommandExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const formatCommandOutput = (
  normalizedCmd: string,
  duration: number,
  result: CommandExecResult
): ToolResult => {
  let output = `$ ${normalizedCmd}\n(completed in ${duration}ms)\n\n`;
  const combined = result.stdout + result.stderr;

  if (result.exitCode !== 0) {
    output += `Exit code: ${result.exitCode}\n\n`;
    output += combined;
    return {
      content: output,
      isError: true,
      metadata: { exitCode: result.exitCode, timedOut: false },
    };
  }

  output += combined;
  return {
    content: output,
    isError: false,
    metadata: { exitCode: 0, timedOut: false },
  };
};

const formatCommandError = (
  normalizedCmd: string,
  duration: number,
  message: string
): ToolResult => {
  if (message.includes("timeout") || message.includes("Timeout")) {
    return {
      content: `$ ${normalizedCmd}\n(completed in ${duration}ms)\n\nTIMEOUT: exceeded 5 minutes\n`,
      isError: true,
      metadata: { exitCode: -1, timedOut: true },
    };
  }

  return {
    content: `$ ${normalizedCmd}\n(completed in ${duration}ms)\n\nError: ${message}\n`,
    isError: true,
    metadata: { exitCode: -1, timedOut: false },
  };
};

const validateAndNormalizeCommand = (
  command: string
): ToolResult | { normalizedCmd: string; parts: string[] } => {
  if (!command) {
    return errorResult("command is required");
  }

  if (hasBlockedBytes(command)) {
    return errorResult("command contains invalid characters");
  }

  const normalizedCmd = normalizeCommand(command);

  const blockedPattern = hasBlockedPattern(normalizedCmd);
  if (blockedPattern) {
    return errorResult(`blocked pattern: "${blockedPattern}"`);
  }

  const parts = normalizedCmd.split(" ").filter(Boolean);
  if (parts.length === 0 || parts[0] === undefined) {
    return errorResult("empty command");
  }

  const baseCmd = extractBaseCommand(parts[0]);
  if (BLOCKED_COMMANDS.has(baseCmd)) {
    return errorResult(`blocked command: "${baseCmd}"`);
  }

  return { normalizedCmd, parts };
};

const executeSandboxCommand = async (
  sandbox: SandboxHandle,
  normalizedCmd: string,
  worktreePath: string,
  abortSignal?: AbortSignal
): Promise<ToolResult> => {
  if (abortSignal?.aborted) {
    return errorResult("operation aborted");
  }

  const startTime = Date.now();

  try {
    const result = await sandbox.commands.run(normalizedCmd, {
      cwd: worktreePath,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });

    return formatCommandOutput(normalizedCmd, Date.now() - startTime, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return formatCommandError(normalizedCmd, Date.now() - startTime, message);
  }
};

export const createSandboxRunCommandTool = (sandbox: SandboxHandle): Tool => ({
  name: "run_command",
  description:
    "Run a shell command. Common build/test/lint commands are pre-approved. Other commands require user approval.",
  inputSchema: new SchemaBuilder()
    .addString(
      "command",
      "The command to run (e.g., 'go test ./...', 'npm run lint', 'make build')"
    )
    .build(),

  execute: async (
    ctx: ToolContext,
    input: unknown,
    abortSignal?: AbortSignal
  ): Promise<ToolResult> => {
    const { command } = input as { command: string };

    const validationResult = validateAndNormalizeCommand(command);
    if ("content" in validationResult) {
      return validationResult;
    }

    const { normalizedCmd, parts } = validationResult;

    const allowed = await isCommandAllowed(ctx, normalizedCmd, parts);
    if (!allowed) {
      return errorResult(`command not approved: ${normalizedCmd}`);
    }

    return executeSandboxCommand(
      sandbox,
      normalizedCmd,
      ctx.worktreePath,
      abortSignal
    );
  },
});

const getFailingStepCommand = (ctx: ToolContext): ToolResult | string => {
  if (!ctx.failingStep) {
    return errorResult("no failing step context available");
  }

  if (!ctx.stepCommands) {
    return errorResult("no step commands available");
  }

  const { jobId, stepIndex } = ctx.failingStep;
  const jobCommands = ctx.stepCommands.get(jobId);

  if (!jobCommands) {
    return errorResult(`job "${jobId}" not found in step commands`);
  }

  if (stepIndex < 0 || stepIndex >= jobCommands.length) {
    return errorResult(
      `step index ${stepIndex} out of range for job "${jobId}"`
    );
  }

  const command = jobCommands[stepIndex];
  if (!command) {
    return errorResult(
      "step does not have a run command (uses action instead)"
    );
  }

  return command;
};

export const createSandboxRunCheckTool = (sandbox: SandboxHandle): Tool => ({
  name: "run_check",
  description:
    "Re-run the failing CI command to verify your fix works. Call this after editing files to confirm the error is resolved.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },

  execute: async (
    ctx: ToolContext,
    _input: unknown,
    abortSignal?: AbortSignal
  ): Promise<ToolResult> => {
    const commandOrError = getFailingStepCommand(ctx);
    if (typeof commandOrError !== "string") {
      return commandOrError;
    }

    const validationResult = validateAndNormalizeCommand(commandOrError);
    if ("content" in validationResult) {
      return validationResult;
    }

    return await executeSandboxCommand(
      sandbox,
      validationResult.normalizedCmd,
      ctx.worktreePath,
      abortSignal
    );
  },
});

export const createSandboxTools = (sandbox: SandboxHandle): Tool[] => [
  createSandboxReadFileTool(sandbox),
  createSandboxEditFileTool(sandbox),
  createSandboxGlobTool(sandbox),
  createSandboxGrepTool(sandbox),
  createSandboxRunCommandTool(sandbox),
  createSandboxRunCheckTool(sandbox),
];
