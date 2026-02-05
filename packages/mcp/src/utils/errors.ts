import {
  DetentApiError,
  DetentAuthError,
  DetentNetworkError,
  sanitizeCredentials,
} from "@detent/sdk";

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

export const formatErrorResponse = (error: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${sanitizeError(error)}` }],
  isError: true,
});

export const jsonResponse = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

export const wrapHandler =
  <T>(fn: (args: T) => Promise<unknown>) =>
  async (args: Record<string, unknown>) => {
    try {
      const result = await fn(args as unknown as T);
      return jsonResponse(result);
    } catch (error) {
      return formatErrorResponse(error);
    }
  };

// HACK: Simplified McpServer interface to avoid OOM during TypeScript compilation.
// The MCP SDK's McpServer type has complex generic inference that exhausts memory.
export interface SimplifiedMcpServer {
  registerTool: (
    name: string,
    opts: { description: string; inputSchema: Record<string, unknown> },
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ) => void;
}
