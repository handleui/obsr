/**
 * Error classification for report API failures.
 * Provides actionable error messages and suggestions for users.
 */

export const REPORT_ERROR_CODES = {
  AUTH_MISSING_TOKEN: "AUTH_MISSING_TOKEN",
  AUTH_INVALID_TOKEN: "AUTH_INVALID_TOKEN",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  SERVER_ERROR: "SERVER_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  UNKNOWN: "UNKNOWN",
} as const;

export type ReportErrorCode =
  (typeof REPORT_ERROR_CODES)[keyof typeof REPORT_ERROR_CODES];

export interface ClassifiedReportError {
  code: ReportErrorCode;
  title: string;
  message: string;
  suggestions: string[];
  docsUrl?: string;
}

const ERROR_CLASSIFICATIONS: Record<ReportErrorCode, ClassifiedReportError> = {
  [REPORT_ERROR_CODES.AUTH_MISSING_TOKEN]: {
    code: REPORT_ERROR_CODES.AUTH_MISSING_TOKEN,
    title: "Authentication token missing",
    message: "No authentication token was provided to the action.",
    suggestions: [
      "Add DETENT_TOKEN to your repository or organization secrets",
      "Ensure your workflow uses: token: secrets.DETENT_TOKEN (in GitHub Actions syntax)",
      "Verify the secret name matches exactly (case-sensitive)",
    ],
    docsUrl: "https://detent.sh/docs/action#configuration",
  },
  [REPORT_ERROR_CODES.AUTH_INVALID_TOKEN]: {
    code: REPORT_ERROR_CODES.AUTH_INVALID_TOKEN,
    title: "Authentication failed",
    message: "The provided token is invalid or has been revoked.",
    suggestions: [
      "Regenerate the API token at detent.sh",
      "Verify the token starts with 'dtk_'",
      "Check that the token belongs to the correct organization",
      "Update the DETENT_TOKEN secret with the new value",
    ],
    docsUrl: "https://detent.sh/docs/action#configuration",
  },
  [REPORT_ERROR_CODES.PROJECT_NOT_FOUND]: {
    code: REPORT_ERROR_CODES.PROJECT_NOT_FOUND,
    title: "Project not found",
    message: "This repository is not registered with Detent.",
    suggestions: [
      "Install the Detent GitHub App on this repository",
      "If using org-wide installation, ensure this repo is included",
      "Wait a few seconds after installation for sync to complete",
      "Verify the repository name matches exactly",
    ],
    docsUrl: "https://detent.sh/docs/quickstart",
  },
  [REPORT_ERROR_CODES.VALIDATION_ERROR]: {
    code: REPORT_ERROR_CODES.VALIDATION_ERROR,
    title: "Invalid request",
    message: "The report payload failed validation.",
    suggestions: [
      "Check that CI tool output files are valid JSON",
      "Ensure error messages are not excessively long (>64KB)",
      "Verify file paths exist and are accessible",
    ],
  },
  [REPORT_ERROR_CODES.RATE_LIMITED]: {
    code: REPORT_ERROR_CODES.RATE_LIMITED,
    title: "Rate limit exceeded",
    message: "Too many requests to the Detent API.",
    suggestions: [
      "Wait a few minutes before retrying",
      "Reduce the frequency of workflow runs if possible",
      "Contact support if this persists",
    ],
  },
  [REPORT_ERROR_CODES.SERVER_ERROR]: {
    code: REPORT_ERROR_CODES.SERVER_ERROR,
    title: "Server error",
    message: "The Detent API encountered an internal error.",
    suggestions: [
      "This is usually temporary - retry in a few minutes",
      "Check status.detent.sh for ongoing incidents",
      "If the problem persists, contact support",
    ],
  },
  [REPORT_ERROR_CODES.NETWORK_ERROR]: {
    code: REPORT_ERROR_CODES.NETWORK_ERROR,
    title: "Network error",
    message: "Failed to connect to the Detent API.",
    suggestions: [
      "Check that backend.detent.sh is reachable from your runner",
      "If using a custom api-url, verify it is correct",
      "Check for firewall rules blocking outbound HTTPS",
      "Retry - this may be a transient network issue",
    ],
  },
  [REPORT_ERROR_CODES.UNKNOWN]: {
    code: REPORT_ERROR_CODES.UNKNOWN,
    title: "Unexpected error",
    message: "An unexpected error occurred while reporting.",
    suggestions: [
      "Check the action logs for more details",
      "Retry the workflow",
      "If the problem persists, report an issue",
    ],
  },
};

/**
 * Determine if an error is a network-level failure.
 */
export const isNetworkError = (error: unknown): boolean => {
  if (error instanceof TypeError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const networkIndicators = [
    "network",
    "fetch",
    "econnrefused",
    "econnreset",
    "etimedout",
    "dns",
    "getaddrinfo",
  ];
  return networkIndicators.some((indicator) => message.includes(indicator));
};

/**
 * Parse API error response body for additional context.
 */
const parseResponseBody = (
  body: string
): { error?: string; hint?: string } | null => {
  try {
    return JSON.parse(body) as { error?: string; hint?: string };
  } catch {
    return null;
  }
};

/**
 * Classify by HTTP status code.
 */
const classifyByStatusCode = (
  statusCode: number,
  responseBody?: string
): ClassifiedReportError | null => {
  const parsed = responseBody ? parseResponseBody(responseBody) : null;

  if (statusCode === 401) {
    const errorText = parsed?.error?.toLowerCase() ?? "";
    const isMissing =
      errorText.includes("missing") || errorText.includes("required");
    return isMissing
      ? ERROR_CLASSIFICATIONS[REPORT_ERROR_CODES.AUTH_MISSING_TOKEN]
      : ERROR_CLASSIFICATIONS[REPORT_ERROR_CODES.AUTH_INVALID_TOKEN];
  }

  if (statusCode === 404) {
    return ERROR_CLASSIFICATIONS[REPORT_ERROR_CODES.PROJECT_NOT_FOUND];
  }

  if (statusCode === 400 || statusCode === 422) {
    const base = ERROR_CLASSIFICATIONS[REPORT_ERROR_CODES.VALIDATION_ERROR];
    return parsed?.error
      ? { ...base, message: `${base.message} ${parsed.error}` }
      : base;
  }

  if (statusCode === 429) {
    return ERROR_CLASSIFICATIONS[REPORT_ERROR_CODES.RATE_LIMITED];
  }

  if (statusCode >= 500) {
    return ERROR_CLASSIFICATIONS[REPORT_ERROR_CODES.SERVER_ERROR];
  }

  return null;
};

/**
 * Classify a report API error into a structured error with suggestions.
 */
export const classifyReportError = (
  error: unknown,
  statusCode?: number,
  responseBody?: string
): ClassifiedReportError => {
  // Network errors take priority
  if (isNetworkError(error)) {
    return ERROR_CLASSIFICATIONS[REPORT_ERROR_CODES.NETWORK_ERROR];
  }

  // Classify by status code if available
  if (statusCode !== undefined) {
    const classified = classifyByStatusCode(statusCode, responseBody);
    if (classified) {
      return classified;
    }
  }

  // Fallback to unknown
  const base = ERROR_CLASSIFICATIONS[REPORT_ERROR_CODES.UNKNOWN];
  const message = error instanceof Error ? error.message : String(error);
  return { ...base, message: `${base.message} ${message}` };
};
