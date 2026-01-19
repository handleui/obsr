import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as core from "@actions/core";

import { getAutofixConfig, isCommandAllowed } from "./registry";

export interface AutofixResult {
  source: string;
  success: boolean;
  patch?: string;
  filesChanged?: Array<{ path: string; content: string | null }>;
  error?: string;
}

const EXEC_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_PATCH_SIZE = 1_000_000; // 1MB
const MAX_FILES_CHANGED = 100; // Limit files to prevent unbounded changes
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const BINARY_CHECK_SIZE = 8192; // Check first 8KB for binary detection

// Security: Regex patterns for path validation (at module level for performance)
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;
const PATH_SEPARATOR_PATTERN = /[/\\]/;

interface ExecResult {
  stdout: string;
  error?: string;
  timedOut?: boolean;
  signal?: string;
}

const execCommand = (command: string): ExecResult => {
  try {
    const stdout = execSync(command, {
      encoding: "utf-8",
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout };
  } catch (error) {
    // execSync throws on non-zero exit code, but some tools exit non-zero even when fixing
    const err = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
      signal?: string;
      killed?: boolean;
    };

    // Check for timeout (process killed due to timeout)
    if (err.killed && err.signal === "SIGTERM") {
      return {
        stdout: err.stdout ?? "",
        error: `Command timed out after ${EXEC_TIMEOUT_MS / 1000}s`,
        timedOut: true,
        signal: err.signal,
      };
    }

    if (err.stdout !== undefined) {
      return { stdout: err.stdout, error: err.stderr || err.message };
    }
    return { stdout: "", error: err.message || String(error) };
  }
};

const getGitPatch = (): { patch?: string; truncated?: boolean } => {
  const { stdout, error } = execCommand("git diff");

  // Empty diff is valid (no changes)
  if (!stdout || stdout.trim() === "") {
    return {};
  }

  // Patch too large - truncate and flag
  if (stdout.length > MAX_PATCH_SIZE) {
    core.warning(
      `Patch size (${stdout.length} bytes) exceeds limit (${MAX_PATCH_SIZE} bytes), truncating`
    );
    return { truncated: true };
  }

  if (error) {
    core.debug(`git diff had error but produced output: ${error}`);
  }

  return { patch: stdout };
};

interface ChangedFilesResult {
  files: string[];
  truncated?: boolean;
}

const getChangedFiles = (): ChangedFilesResult => {
  const { stdout, error } = execCommand("git diff --name-only");

  // Empty is valid (no changes)
  if (!stdout || stdout.trim() === "") {
    return { files: [] };
  }

  if (error) {
    core.debug(`git diff --name-only had error but produced output: ${error}`);
  }

  const files = stdout
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);

  // Limit number of files changed
  if (files.length > MAX_FILES_CHANGED) {
    core.warning(
      `Number of changed files (${files.length}) exceeds limit (${MAX_FILES_CHANGED}), truncating`
    );
    return { files: files.slice(0, MAX_FILES_CHANGED), truncated: true };
  }

  return { files };
};

/**
 * Validate file path is safe (no path traversal).
 * Returns true if path is safe, false otherwise.
 *
 * Security: Rejects paths with:
 * - ".." (directory traversal)
 * - Absolute paths (starting with /)
 * - Null bytes
 */
const isPathSafe = (filePath: string): boolean => {
  // Reject null bytes
  if (filePath.includes("\0")) {
    return false;
  }

  // Reject absolute paths
  if (filePath.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(filePath)) {
    return false;
  }

  // Reject directory traversal attempts
  const segments = filePath.split(PATH_SEPARATOR_PATTERN);
  for (const segment of segments) {
    if (segment === ".." || segment === ".") {
      return false;
    }
  }

  return true;
};

/**
 * Check if a buffer contains binary content by looking for null bytes.
 * This is a simple heuristic used by git and other tools.
 */
const isBinaryContent = (buffer: Buffer): boolean => {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
};

const readFileContent = (filePath: string): string | null => {
  // SECURITY: Validate path before reading to prevent path traversal
  if (!isPathSafe(filePath)) {
    core.warning(`Skipping unsafe file path: ${filePath}`);
    return null;
  }

  try {
    const buffer = readFileSync(filePath);

    // Skip binary files (images, compiled assets, etc.)
    if (isBinaryContent(buffer)) {
      core.debug(`Skipping binary file: ${filePath}`);
      return null;
    }

    // Skip files that are too large
    if (buffer.length > MAX_FILE_SIZE) {
      core.warning(
        `Skipping large file (${(buffer.length / 1024 / 1024).toFixed(2)}MB): ${filePath}`
      );
      return null;
    }

    return buffer.toString("utf-8");
  } catch {
    // File may have been deleted
    return null;
  }
};

export const runAutofix = (source: string): AutofixResult => {
  const config = getAutofixConfig(source);

  if (!config?.command) {
    return {
      source,
      success: false,
      error: `No autofix config found for source: ${source}`,
    };
  }

  // Security: validate command is in allowlist
  if (!isCommandAllowed(config.command)) {
    core.warning(
      `Command not in allowlist: ${config.command}. Skipping autofix for ${source}.`
    );
    return {
      source,
      success: false,
      error: `Command not allowed: ${config.command}`,
    };
  }

  core.info(`Running autofix for ${source}: ${config.command}`);

  // Run the autofix command
  const execResult = execCommand(config.command);

  // If command timed out, fail immediately without checking git diff
  if (execResult.timedOut) {
    core.error(`Autofix for ${source} timed out`);
    return {
      source,
      success: false,
      error: execResult.error,
    };
  }

  // Get git diff to see what changed
  const patchResult = getGitPatch();
  const changedFilesResult = getChangedFiles();

  // SECURITY: Filter out unsafe paths before processing
  const safeFiles = changedFilesResult.files.filter((path) => {
    if (!isPathSafe(path)) {
      core.warning(`Skipping unsafe file path from git output: ${path}`);
      return false;
    }
    return true;
  });

  // Read content of changed files (handles deleted files gracefully)
  const filesChanged = safeFiles.map((path) => ({
    path,
    content: readFileContent(path),
  }));

  const success = safeFiles.length > 0;

  // Build error message with context
  let errorMessage = execResult.error;
  if (patchResult.truncated || changedFilesResult.truncated) {
    const truncationWarnings: string[] = [];
    if (patchResult.truncated) {
      truncationWarnings.push("patch truncated due to size limit");
    }
    if (changedFilesResult.truncated) {
      truncationWarnings.push("files list truncated due to count limit");
    }
    const warning = truncationWarnings.join("; ");
    errorMessage = errorMessage ? `${errorMessage}; ${warning}` : warning;
  }

  if (success) {
    core.info(
      `Autofix for ${source} changed ${safeFiles.length} file(s)${changedFilesResult.truncated ? " (truncated)" : ""}`
    );
  } else if (errorMessage) {
    core.warning(`Autofix for ${source} completed with error: ${errorMessage}`);
  } else {
    core.info(`Autofix for ${source} made no changes`);
  }

  return {
    source,
    success,
    patch: patchResult.patch,
    filesChanged: filesChanged.length > 0 ? filesChanged : undefined,
    error: errorMessage,
  };
};
