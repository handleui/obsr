// ============================================================================
// Helper: Sanitize error messages for user-facing output
// ============================================================================
// Known safe error patterns that can be shown to users
const SAFE_ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /Invalid zip payload/i, message: "Invalid log archive format" },
  { pattern: /Zip archive contained no files/i, message: "Empty log archive" },
  {
    pattern: /Logs exceed maximum size/i,
    message: "Log files too large to process",
  },
  {
    pattern: /Zip archive.*exceed.*maximum size/i,
    message: "Log archive too large",
  },
  {
    pattern: /suspicious compression ratio/i,
    message: "Invalid log archive format",
  },
  {
    pattern: /too many files/i,
    message: "Log archive contains too many files",
  },
  {
    pattern: /Rate limit exceeded/i,
    message: "GitHub API rate limit exceeded",
  },
  { pattern: /Failed to fetch logs: 404/i, message: "Logs not available" },
  { pattern: /Failed to fetch logs: 403/i, message: "Log access denied" },
  {
    pattern: /Failed to fetch logs: 5\d{2}/i,
    message: "GitHub API unavailable",
  },
];

export const sanitizeErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return "An unexpected error occurred";
  }

  const message = error.message;

  // Check against known safe patterns
  for (const { pattern, message: safeMessage } of SAFE_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return safeMessage;
    }
  }

  // For unknown errors, return a generic message to avoid leaking internal details
  // The full error is logged to console for debugging
  return "An internal error occurred while processing logs";
};

// ============================================================================
// Error codes for webhook processing - helps with debugging and correlation
// ============================================================================
// Each error code identifies a specific failure category for easier diagnosis.
// Format: WEBHOOK_<EVENT>_<CATEGORY> (e.g., WEBHOOK_WORKFLOW_TOKEN_FAILED)
export const ERROR_CODES = {
  // Token/auth errors
  TOKEN_FAILED: "WEBHOOK_TOKEN_FAILED",

  // GitHub API errors
  GITHUB_RATE_LIMIT: "WEBHOOK_GITHUB_RATE_LIMIT",
  GITHUB_NOT_FOUND: "WEBHOOK_GITHUB_NOT_FOUND",
  GITHUB_API_ERROR: "WEBHOOK_GITHUB_API_ERROR",

  // Database errors
  DB_CONNECTION: "WEBHOOK_DB_CONNECTION",

  // Workflow processing errors
  WORKFLOW_LOG_FETCH: "WEBHOOK_WORKFLOW_LOG_FETCH",
  WORKFLOW_VALIDATION: "WEBHOOK_WORKFLOW_VALIDATION",

  // Generic errors
  UNKNOWN: "WEBHOOK_UNKNOWN_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ClassifiedError {
  code: ErrorCode;
  message: string;
  hint?: string;
}

// ============================================================================
// Helper: Classify and sanitize error for API responses
// ============================================================================
// Returns a structured error with:
// - code: Machine-readable error code for programmatic handling
// - message: Human-readable description (sanitized for security)
// - hint: Optional troubleshooting suggestion
//
// Prevents leaking internal implementation details (e.g., database connection
// strings, file paths, stack traces) in error responses.

// Helper: Detect which resource is not found from error message
const detectNotFoundResource = (message: string): string => {
  if (message.includes("repository")) {
    return "repository";
  }
  if (message.includes("check run")) {
    return "check run";
  }
  if (message.includes("comment")) {
    return "comment";
  }
  if (message.includes("workflow")) {
    return "workflow run";
  }
  if (message.includes("pull request") || message.includes("pr")) {
    return "pull request";
  }
  return "resource";
};

// Helper: Check if message indicates token/auth error
const isTokenError = (message: string): boolean =>
  message.includes("installation token") ||
  message.includes("bad credentials") ||
  message.includes("authentication");

// Helper: Check if message indicates database error
// Note: Avoid provider-specific identifiers to prevent implementation leakage
const isDatabaseError = (message: string): boolean =>
  message.includes("database") ||
  (message.includes("connection") && !message.includes("github")) ||
  message.includes("econnrefused") ||
  message.includes("sql error") ||
  message.includes("sql syntax") ||
  message.includes("violates constraint");

// Helper: Check if message indicates GitHub API error
const isGitHubApiError = (message: string): boolean =>
  message.includes("github api") || message.includes("octokit");

export const classifyError = (error: unknown): ClassifiedError => {
  if (!(error instanceof Error)) {
    return {
      code: ERROR_CODES.UNKNOWN,
      message: "An unexpected error occurred",
      hint: "Check server logs with the delivery ID for details",
    };
  }

  const message = error.message.toLowerCase();

  // Token/auth errors
  if (isTokenError(message)) {
    return {
      code: ERROR_CODES.TOKEN_FAILED,
      message: "Failed to authenticate with GitHub",
      hint: "The GitHub App installation may be suspended or the app needs to be reinstalled",
    };
  }

  // Rate limiting
  if (message.includes("rate limit")) {
    return {
      code: ERROR_CODES.GITHUB_RATE_LIMIT,
      message: "GitHub API rate limit exceeded",
      hint: "Wait a few minutes and retry, or check for excessive API calls",
    };
  }

  // Not found errors
  if (message.includes("not found") || message.includes("404")) {
    const resource = detectNotFoundResource(message);
    return {
      code: ERROR_CODES.GITHUB_NOT_FOUND,
      message: `${resource.charAt(0).toUpperCase() + resource.slice(1)} not found`,
      hint: `The ${resource} may have been deleted, or the app may not have access`,
    };
  }

  // Database errors
  if (isDatabaseError(message)) {
    return {
      code: ERROR_CODES.DB_CONNECTION,
      message: "Database connection error",
      hint: "Transient database issue - webhook will be retried automatically",
    };
  }

  // Log fetching errors
  if (message.includes("fetch") && message.includes("log")) {
    return {
      code: ERROR_CODES.WORKFLOW_LOG_FETCH,
      message: "Failed to fetch workflow logs",
      hint: "GitHub may be experiencing issues, or logs may have expired",
    };
  }

  // Validation errors (safe to expose)
  if (message.includes("[workflow_run] invalid")) {
    return {
      code: ERROR_CODES.WORKFLOW_VALIDATION,
      message: error.message.slice(0, 200),
    };
  }

  // GitHub API errors (generic)
  if (isGitHubApiError(message)) {
    return {
      code: ERROR_CODES.GITHUB_API_ERROR,
      message: "GitHub API request failed",
      hint: "Check GitHub status page or retry the webhook",
    };
  }

  // Default: unknown error
  return {
    code: ERROR_CODES.UNKNOWN,
    message: "An internal error occurred",
    hint: "Check server logs with the delivery ID for details",
  };
};
