/**
 * MCP Error Handling Utilities
 *
 * Sanitizes error messages to prevent leaking sensitive information
 * like tokens, keys, or internal system details.
 */

import {
  DetentApiError,
  DetentAuthError,
  DetentNetworkError,
} from "@detent/sdk";

/** Sanitize error messages to avoid leaking sensitive info */
export const sanitizeError = (error: unknown): string => {
  if (error instanceof DetentAuthError) {
    return "Authentication failed. Please check your credentials.";
  }
  if (error instanceof DetentNetworkError) {
    return "Network error. Please check your connection.";
  }
  if (error instanceof DetentApiError) {
    // Sanitize API error messages to prevent token leakage
    const sanitized = error.message
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(/dtk_[^\s"']+/gi, "[REDACTED_KEY]")
      .replace(/token[=:]\s*[^\s"']+/gi, "token=[REDACTED]")
      .replace(
        /"?access_token"?\s*[:=]\s*[^\s,}]+/gi,
        "access_token=[REDACTED]"
      )
      .replace(
        /"?refresh_token"?\s*[:=]\s*[^\s,}]+/gi,
        "refresh_token=[REDACTED]"
      )
      .replace(/"?jwt"?\s*[:=]\s*[^\s,}]+/gi, "jwt=[REDACTED]");
    return `API error (${error.status}): ${sanitized}`;
  }
  if (error instanceof Error) {
    // Redact potentially sensitive terms from unexpected errors
    return error.message
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
      .replace(/dtk_[^\s"']+/gi, "[REDACTED_KEY]")
      .replace(/token[=:]\s*[^\s"']+/gi, "token=[REDACTED]")
      .replace(
        /"?access_token"?\s*[:=]\s*[^\s,}]+/gi,
        "access_token=[REDACTED]"
      )
      .replace(
        /"?refresh_token"?\s*[:=]\s*[^\s,}]+/gi,
        "refresh_token=[REDACTED]"
      )
      .replace(/"?jwt"?\s*[:=]\s*[^\s,}]+/gi, "jwt=[REDACTED]");
  }
  return "An unexpected error occurred";
};

/** Format error response for MCP tool output */
export const formatErrorResponse = (error: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${sanitizeError(error)}` }],
  isError: true,
});
