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
  sanitizeCredentials,
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
    return `API error (${error.status}): ${sanitizeCredentials(error.message)}`;
  }
  if (error instanceof Error) {
    return sanitizeCredentials(error.message);
  }
  return "An unexpected error occurred";
};

/** Format error response for MCP tool output */
export const formatErrorResponse = (error: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${sanitizeError(error)}` }],
  isError: true,
});
