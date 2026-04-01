/**
 * Error enrichment service for adding file context from remote repositories.
 * Fetches source code snippets for errors that have file/line information.
 *
 * Currently supports GitHub. GitLab support is planned.
 *
 * @module error-enrichment
 */

import { extname } from "node:path";
import type { CIError, CodeSnippet } from "@obsr/types";
import { fetchFileContents } from "./github/file-content";

// ============================================================================
// Constants
// ============================================================================

const MAX_FILES_TO_FETCH = 20;
const CONTEXT_LINES = 3;
const MAX_LINE_LENGTH = 500;
/** Skip files larger than 500KB to avoid memory issues with snippet extraction */
const MAX_FILE_SIZE_FOR_SNIPPET = 512 * 1024;

// ============================================================================
// Types
// ============================================================================

export type EnrichmentStatus =
  | "enriched"
  | "skipped_rate_limit"
  | "failed"
  | "no_location"
  | "already_has_snippet"
  | "sensitive_file";

export interface EnrichmentStats {
  total: number;
  enriched: number;
  skippedRateLimit: number;
  failed: number;
  noLocation: number;
  alreadyHasSnippet: number;
  sensitiveFile: number;
  uniqueFilesRequested: number;
  uniqueFilesFetched: number;
}

/**
 * Context required for file enrichment from GitHub.
 */
export interface FileEnrichmentContext {
  token: string;
  owner: string;
  repo: string;
  commitSha: string;
}

/**
 * Alias for FileEnrichmentContext for convenience.
 */
export type EnrichmentContext = FileEnrichmentContext;

// ============================================================================
// Sensitive File Patterns
// ============================================================================

const sensitiveFilePatterns = new Set([
  // Environment files
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".env.staging",
  // Config files that may contain secrets
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  // Auth configuration
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  // SSH keys
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "known_hosts",
  "authorized_keys",
  // Certificates and keys
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  // System credential files
  "htpasswd",
  "shadow",
  "passwd",
  ".htaccess",
  // Cloud provider configs
  ".aws",
  ".ssh",
  ".gnupg",
  ".pgpass",
  "kubeconfig",
  ".kube",
  ".docker",
  "gcloud",
  // Token files
  "token",
  "token.json",
  "tokens.json",
  ".git-credentials",
  // Service account files
  "service-account.json",
  "service_account.json",
  "firebase-adminsdk.json",
  "google-credentials.json",
  // Database files
  "database.yml",
  // Terraform
  "terraform.tfvars",
  // Ansible vault
  "vault.yml",
  "vault.yaml",
]);

const sensitiveExtensions = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
  ".pub",
  ".crt",
  ".cer",
  ".der",
  ".gpg",
  ".asc",
  ".sqlite",
  ".db",
]);

const sensitivePathSegments = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".gcloud",
  "secrets",
  "credentials",
  "private",
  "private-keys",
  ".git",
  "node_modules", // May contain sensitive config
  ".terraform",
  "vault",
]);

// ============================================================================
// Language Detection
// ============================================================================

const extensionToLanguage: Readonly<Record<string, string>> = {
  ".go": "go",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".pyw": "python",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".sql": "sql",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
};

const detectLanguage = (filePath: string): string => {
  const ext = extname(filePath).toLowerCase();
  return extensionToLanguage[ext] ?? "text";
};

// ============================================================================
// Helper Functions
// ============================================================================

// Regex for splitting path segments (defined at top level for performance)
const pathSeparatorRegex = /[/\\]/;

/**
 * Check if a file path matches known sensitive file patterns.
 */
const isSensitiveFile = (filePath: string): boolean => {
  // Security: Reject path traversal attempts
  // Note: Absolute paths (starting with /) are allowed since they're common in
  // Docker containers (e.g., /app/src/file.ts). Home directory patterns below
  // handle PII concerns for user-specific paths.
  if (filePath.includes("..")) {
    return true;
  }

  // Get basename without path
  const segments = filePath.split(pathSeparatorRegex);
  const base = segments.at(-1) ?? "";
  const lowerBase = base.toLowerCase();

  // Check exact filename matches
  if (sensitiveFilePatterns.has(base)) {
    return true;
  }

  // Check for .env prefix variants (case-insensitive)
  if (lowerBase.startsWith(".env")) {
    return true;
  }

  // Check for config files that commonly contain secrets
  if (
    lowerBase.endsWith("-config.json") ||
    lowerBase.endsWith(".config.json") ||
    lowerBase.includes("secret") ||
    lowerBase.includes("credential") ||
    lowerBase.includes("password")
  ) {
    return true;
  }

  // Check file extension
  const ext = extname(base).toLowerCase();
  if (sensitiveExtensions.has(ext)) {
    return true;
  }

  // Check path segments
  for (const segment of segments) {
    if (sensitivePathSegments.has(segment.toLowerCase())) {
      return true;
    }
  }

  return false;
};

/**
 * Check if a file path looks like a test file.
 */
const isTestFile = (filePath: string): boolean => {
  const lower = filePath.toLowerCase();
  return (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("/__tests__/") ||
    lower.startsWith("__tests__/") ||
    lower.startsWith("test/") ||
    lower.startsWith("tests/") ||
    lower.includes(".test.") ||
    lower.includes(".spec.")
  );
};

/**
 * Truncate a line to MAX_LINE_LENGTH.
 */
const truncateLine = (line: string): string => {
  if (line.length <= MAX_LINE_LENGTH) {
    return line;
  }
  return `${line.slice(0, MAX_LINE_LENGTH - 3)}...`;
};

/**
 * Extract a code snippet from file content.
 * Optimized to avoid splitting the entire file when possible.
 */
const extractSnippetFromContent = (
  content: string,
  errorLine: number,
  filePath: string,
  fileSize: number
): CodeSnippet | null => {
  // Skip very large files to avoid memory issues
  if (fileSize > MAX_FILE_SIZE_FOR_SNIPPET) {
    console.log(
      JSON.stringify({
        service: "enrichment",
        action: "skip_large_file",
        filePath,
        fileSizeKB: Math.round(fileSize / 1024),
        maxSizeKB: Math.round(MAX_FILE_SIZE_FOR_SNIPPET / 1024),
      })
    );
    return null;
  }

  // For smaller files, extract only the lines we need without splitting everything
  // This is more memory efficient for large files
  const targetStart = Math.max(1, errorLine - CONTEXT_LINES);
  const targetEnd = errorLine + CONTEXT_LINES;

  const lines: string[] = [];
  let currentLine = 0;
  let lineStart = 0;

  // Scan through content to find target lines
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === "\n") {
      currentLine++;

      if (currentLine >= targetStart && currentLine <= targetEnd) {
        const lineContent = content.slice(lineStart, i);
        lines.push(truncateLine(lineContent));
      }

      // Early exit once we've collected all needed lines
      if (currentLine > targetEnd) {
        break;
      }

      lineStart = i + 1;
    }
  }

  if (lines.length === 0) {
    return null;
  }

  // Adjust startLine based on what we actually found
  const actualStartLine = targetStart;

  // Calculate error line position within snippet (1-indexed)
  let errorLineInSnippet = errorLine - actualStartLine + 1;
  if (errorLineInSnippet < 1) {
    errorLineInSnippet = 1;
  }
  if (errorLineInSnippet > lines.length) {
    errorLineInSnippet = lines.length;
  }

  return {
    lines,
    startLine: actualStartLine,
    errorLine: errorLineInSnippet,
    language: detectLanguage(filePath),
  };
};

// ============================================================================
// Main Enrichment Function
// ============================================================================

interface ErrorEnrichmentInfo {
  error: CIError;
  index: number;
  status: EnrichmentStatus;
  filePath?: string;
}

/**
 * Classify an error to determine if it needs enrichment.
 * Returns the classification status and updates stats.
 */
const classifyError = (
  error: CIError,
  stats: EnrichmentStats
): EnrichmentStatus => {
  if (error.codeSnippet) {
    stats.alreadyHasSnippet++;
    return "already_has_snippet";
  }
  if (!(error.filePath && error.line) || error.line <= 0) {
    stats.noLocation++;
    return "no_location";
  }
  if (isSensitiveFile(error.filePath)) {
    stats.sensitiveFile++;
    return "sensitive_file";
  }
  return "enriched";
};

/**
 * Prioritize files by error count (descending) and test file status.
 */
const prioritizeFiles = (errorCountByFile: Map<string, number>): string[] => {
  const uniqueFiles = [...errorCountByFile.keys()];
  return uniqueFiles
    .map((file) => ({
      file,
      count: errorCountByFile.get(file) ?? 0,
      isTest: isTestFile(file),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      if (a.isTest !== b.isTest) {
        return a.isTest ? 1 : -1;
      }
      return 0;
    })
    .slice(0, MAX_FILES_TO_FETCH)
    .map((item) => item.file);
};

/**
 * Enrich errors with code snippets from GitHub file contents.
 */
export const enrichErrorsWithFileContext = async (
  errors: CIError[],
  ctx: FileEnrichmentContext
): Promise<{
  errors: CIError[];
  stats: EnrichmentStats;
}> => {
  const stats: EnrichmentStats = {
    total: errors.length,
    enriched: 0,
    skippedRateLimit: 0,
    failed: 0,
    noLocation: 0,
    alreadyHasSnippet: 0,
    sensitiveFile: 0,
    uniqueFilesRequested: 0,
    uniqueFilesFetched: 0,
  };

  // Early exit for empty input
  if (errors.length === 0) {
    return { errors: [], stats };
  }

  // Single-pass classification: categorize errors and collect those needing enrichment
  const needsEnrichment: Array<ErrorEnrichmentInfo & { filePath: string }> = [];

  for (let index = 0; index < errors.length; index++) {
    const error = errors[index];
    if (!error) {
      continue;
    }

    const status = classifyError(error, stats);
    if (status === "enriched" && error.filePath) {
      needsEnrichment.push({ error, index, status, filePath: error.filePath });
    }
  }

  if (needsEnrichment.length === 0) {
    // Structured log for Cloudflare Workers observability
    console.log(
      JSON.stringify({
        service: "enrichment",
        action: "skip",
        reason: "no_enrichable_errors",
        stats: {
          alreadyHasSnippet: stats.alreadyHasSnippet,
          noLocation: stats.noLocation,
          sensitiveFile: stats.sensitiveFile,
        },
      })
    );
    return { errors: [...errors], stats };
  }

  // Count errors per file and prioritize
  const errorCountByFile = new Map<string, number>();
  for (const info of needsEnrichment) {
    errorCountByFile.set(
      info.filePath,
      (errorCountByFile.get(info.filePath) ?? 0) + 1
    );
  }
  stats.uniqueFilesRequested = errorCountByFile.size;
  const prioritizedFiles = prioritizeFiles(errorCountByFile);

  // Fetch file contents from GitHub
  const fileContents = await fetchFileContents(
    ctx.token,
    ctx.owner,
    ctx.repo,
    prioritizedFiles,
    ctx.commitSha
  );

  stats.uniqueFilesFetched = fileContents.size;

  // Track which files were requested but not fetched (rate limited)
  const filesNotFetched = new Set(
    prioritizedFiles.filter((f) => !fileContents.has(f))
  );

  // Enrich errors
  const resultErrors = [...errors];

  for (const info of needsEnrichment) {
    const fileResult = fileContents.get(info.filePath);

    if (!fileResult) {
      // File not fetched - either rate limited or not found
      if (filesNotFetched.has(info.filePath)) {
        // Was requested but not returned - likely rate limited
        info.status = "skipped_rate_limit";
        stats.skippedRateLimit++;
      } else {
        // Not in prioritized list (exceeded MAX_FILES_TO_FETCH) or 404
        info.status = "failed";
        stats.failed++;
      }
      continue;
    }

    // Extract snippet (pass file size for memory protection)
    const snippet = extractSnippetFromContent(
      fileResult.content,
      info.error.line ?? 0,
      info.filePath,
      fileResult.size
    );

    if (!snippet) {
      info.status = "failed";
      stats.failed++;
      continue;
    }

    // Create enriched error
    resultErrors[info.index] = {
      ...info.error,
      codeSnippet: snippet,
    };
    stats.enriched++;
  }

  // Structured log for Cloudflare Workers observability
  console.log(
    JSON.stringify({
      service: "enrichment",
      action: "complete",
      stats: {
        total: stats.total,
        enriched: stats.enriched,
        skippedRateLimit: stats.skippedRateLimit,
        failed: stats.failed,
        uniqueFilesRequested: stats.uniqueFilesRequested,
        uniqueFilesFetched: stats.uniqueFilesFetched,
      },
    })
  );

  return { errors: resultErrors, stats };
};
