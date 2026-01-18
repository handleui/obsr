export const GITHUB_API = "https://api.github.com";

export const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;
export const GITHUB_BRANCH_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._/]*$/;
export const GIT_SHA_PATTERN = /^[a-fA-F0-9]{7,40}$/;
export const GIT_FULL_SHA_PATTERN = /^[a-fA-F0-9]{40}$/;

// Maximum allowed file path length (GitHub's limit is 4096)
const MAX_FILE_PATH_LENGTH = 4096;

// Allowed characters in file paths (alphanumeric, common path chars)
// Excludes null bytes and other control characters
const SAFE_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9._@+-]+$/;

// Control characters pattern for security checks (0x00-0x1F except tab, and 0x7F)
// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional security check for control characters
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentional security check for control characters
const SEGMENT_CONTROL_CHARS_PATTERN = /[\x00-\x1F\x7F]/;

// Windows-style absolute path pattern
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:/;

export const isValidGitHubName = (name: string): boolean => {
  return (
    name.length > 0 &&
    name.length <= 100 &&
    GITHUB_NAME_PATTERN.test(name) &&
    !name.includes("..")
  );
};

export const isValidBranchName = (branch: string): boolean => {
  return (
    branch.length > 0 &&
    branch.length <= 255 &&
    GITHUB_BRANCH_PATTERN.test(branch) &&
    !branch.includes("..") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/")
  );
};

export const isValidGitSha = (sha: string): boolean => {
  return GIT_SHA_PATTERN.test(sha);
};

export const validateOwnerRepo = (
  owner: string,
  repo: string,
  context: string
): void => {
  if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
    throw new Error(`${context}: Invalid owner or repo name`);
  }
};

export const validateGitSha = (sha: string, context: string): void => {
  if (!isValidGitSha(sha)) {
    throw new Error(
      `${context}: Invalid SHA format. Expected 7-40 character hex string`
    );
  }
};

export const validateIssueNumber = (
  issueNumber: number,
  context: string
): void => {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`${context}: Invalid issue number`);
  }
};

export const validateCommentId = (commentId: number, context: string): void => {
  if (!Number.isInteger(commentId) || commentId <= 0) {
    throw new Error(`${context}: Invalid comment ID`);
  }
};

/**
 * Validate and sanitize a file path to prevent path traversal attacks.
 * Returns the normalized path or throws if invalid.
 *
 * Security checks:
 * - Rejects paths with ".." (directory traversal)
 * - Rejects absolute paths (starting with / or containing drive letters)
 * - Rejects paths with null bytes or control characters
 * - Rejects paths exceeding maximum length
 * - Normalizes path separators
 */
export const validateFilePath = (path: string, context: string): string => {
  if (!path || path.trim().length === 0) {
    throw new Error(`${context}: File path cannot be empty`);
  }

  // Check maximum length
  if (path.length > MAX_FILE_PATH_LENGTH) {
    throw new Error(
      `${context}: File path exceeds maximum length (${MAX_FILE_PATH_LENGTH})`
    );
  }

  // Reject null bytes (can bypass security checks in some systems)
  if (path.includes("\0")) {
    throw new Error(`${context}: File path contains invalid characters`);
  }

  // Reject control characters (0x00-0x1F except tab, and 0x7F)
  if (CONTROL_CHARS_PATTERN.test(path)) {
    throw new Error(`${context}: File path contains invalid characters`);
  }

  // Normalize path separators (Windows backslashes to forward slashes)
  const normalizedPath = path.replace(/\\/g, "/");

  // Reject absolute paths
  if (normalizedPath.startsWith("/")) {
    throw new Error(`${context}: Absolute paths are not allowed`);
  }

  // Reject Windows-style absolute paths (C:, D:, etc.)
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(normalizedPath)) {
    throw new Error(`${context}: Absolute paths are not allowed`);
  }

  // Split into segments and validate each
  const segments = normalizedPath.split("/").filter((s) => s.length > 0);

  if (segments.length === 0) {
    throw new Error(`${context}: File path cannot be empty`);
  }

  for (const segment of segments) {
    // Reject directory traversal
    if (segment === ".." || segment === ".") {
      throw new Error(`${context}: Path traversal not allowed`);
    }

    // Reject segments that are too long (255 is common filesystem limit)
    if (segment.length > 255) {
      throw new Error(`${context}: Path segment exceeds maximum length`);
    }

    // Check for suspicious patterns that could indicate injection attempts
    // Allow most characters but reject control characters
    if (
      !SAFE_PATH_SEGMENT_PATTERN.test(segment) &&
      SEGMENT_CONTROL_CHARS_PATTERN.test(segment)
    ) {
      throw new Error(`${context}: Path segment contains invalid characters`);
    }
  }

  // Return the normalized path (joined back with forward slashes)
  return segments.join("/");
};

/**
 * Check if a path is safe (doesn't contain traversal attempts).
 * Returns true if safe, false otherwise.
 */
export const isPathSafe = (path: string): boolean => {
  try {
    validateFilePath(path, "isPathSafe");
    return true;
  } catch {
    return false;
  }
};
