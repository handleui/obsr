/**
 * Extract related file paths from stack traces and error context.
 * Post-processes AI extraction to populate the relatedFiles field.
 */

/** Maximum number of related files to extract */
const MAX_RELATED_FILES = 10;

/** Maximum stack trace length to process (1MB) */
const MAX_STACKTRACE_LENGTH = 1024 * 1024;

/** Patterns for extracting file paths from stack traces */
const FILE_PATH_PATTERNS = [
  // Node.js: at ... (filepath:line:col) - extract path from inside parentheses
  /\(([^()]+\.[a-z]+):\d+(?::\d+)?\)/gi,
  // Node.js: at filepath:line:col (no parentheses, path at end of line after "at")
  /at\s+([^\s():]+\.[a-z]+):\d+(?::\d+)?$/gim,
  // Python: File "filepath", line X
  /File\s+"([^"]+)"/gi,
  // Go/Rust/generic: filepath:line:col (absolute paths starting with /)
  /(?:^|\s)(\/[\w./-]+\.[a-z]+):\d+(?::\d+)?/gim,
];

/** Paths to exclude (dependencies, internals) */
const EXCLUDED_PATTERNS = [
  /node_modules\//,
  /\.cargo\//,
  /site-packages\//,
  /vendor\//,
  /\/__pycache__\//,
  /\/\..*\//, // Hidden directories
];

/** Regex for checking file extension */
const HAS_EXTENSION_PATTERN = /\.[a-z]+$/i;

/** Regex patterns for path normalization */
const LEADING_DOT_SLASH = /^\.\//;
const BACKSLASH = /\\/g;

/**
 * Extract file paths from a stack trace string.
 * Deduplicates and filters out dependency paths.
 *
 * @param stackTrace - Raw stack trace string
 * @param primaryFile - The main error file path (will be excluded from results)
 * @returns Array of unique file paths mentioned in the stack trace
 */
export const extractRelatedFiles = (
  stackTrace: string | undefined | null,
  primaryFile?: string
): string[] => {
  if (!stackTrace) {
    return [];
  }

  // Bound input length to prevent DoS
  const bounded =
    stackTrace.length > MAX_STACKTRACE_LENGTH
      ? stackTrace.slice(0, MAX_STACKTRACE_LENGTH)
      : stackTrace;

  const found = new Set<string>();
  // Normalize primaryFile once instead of per-match
  const normalizedPrimary = primaryFile
    ? normalizeFilePath(primaryFile)
    : undefined;

  for (const pattern of FILE_PATH_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;

    for (const match of bounded.matchAll(pattern)) {
      const filePath = match[1];
      if (filePath) {
        const normalized = normalizeFilePath(filePath);
        if (isValidFilePath(filePath, normalized, normalizedPrimary)) {
          found.add(normalized);
        }
      }
    }
  }

  return Array.from(found).slice(0, MAX_RELATED_FILES);
};

/**
 * Check if a file path is valid and not excluded.
 * @param filePath - Original file path (for pattern matching)
 * @param normalized - Pre-normalized path (for primary file comparison)
 * @param normalizedPrimary - Pre-normalized primary file path
 */
const isValidFilePath = (
  filePath: string,
  normalized: string,
  normalizedPrimary?: string
): boolean => {
  // Skip the primary file (use pre-normalized paths to avoid redundant work)
  if (normalizedPrimary && normalized === normalizedPrimary) {
    return false;
  }

  // Skip excluded paths (dependencies, etc.)
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(filePath)) {
      return false;
    }
  }

  // Must have a valid extension
  if (!HAS_EXTENSION_PATTERN.test(filePath)) {
    return false;
  }

  // Skip paths that look like URLs or packages
  if (filePath.startsWith("http") || filePath.startsWith("@")) {
    return false;
  }

  // Security: reject path traversal attempts
  // This guards against malicious stack traces attempting directory escape.
  // We check multiple variants since paths come from untrusted error output.
  if (!isSafeRelativePath(filePath)) {
    return false;
  }

  return true;
};

/**
 * Validate that a path doesn't attempt directory traversal.
 * Security boundary: paths come from untrusted stack traces in error output.
 *
 * Checks for:
 * - Literal `..` sequences
 * - URL-encoded variants (`%2e%2e`, `%2E%2E`)
 * - Backslash variants for Windows-style paths (`..\\`, `..\/`)
 * - Null bytes (path truncation attacks)
 */
const isSafeRelativePath = (filePath: string): boolean => {
  // Reject null bytes (could truncate path validation)
  if (filePath.includes("\0")) {
    return false;
  }

  // Normalize: decode URL encoding and convert backslashes
  // This catches %2e%2e and mixed slash variants
  let normalized: string;
  try {
    normalized = decodeURIComponent(filePath);
  } catch {
    // Invalid encoding - reject to be safe
    return false;
  }
  normalized = normalized.replace(/\\/g, "/");

  // Reject if normalized path contains parent directory traversal
  if (normalized.includes("..")) {
    return false;
  }

  return true;
};

/**
 * Normalize a file path for deduplication.
 * Removes leading ./ and normalizes slashes.
 */
const normalizeFilePath = (filePath: string): string => {
  return filePath.replace(LEADING_DOT_SLASH, "").replace(BACKSLASH, "/");
};
