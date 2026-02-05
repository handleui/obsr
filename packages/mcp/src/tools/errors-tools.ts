/**
 * Errors MCP Tools
 */

import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

// Type escape for MCP SDK's complex registerTool generics
interface ServerWithRegisterTool {
  registerTool: CallableFunction;
}

export const registerErrorsTools = (
  server: McpServer,
  client: DetentClient
) => {
  const srv = server as unknown as ServerWithRegisterTool;

  srv.registerTool(
    "detent_get_errors",
    {
      description: `Get CI errors for a specific commit in a repository.

Returns errors from failed CI runs including:
- File path, line, and column
- Error message and category
- Severity and source tool
- Associated workflow runs`,
      inputSchema: z.object({
        commit: z.string().describe("Git commit SHA"),
        repository: z
          .string()
          .describe('Repository full name (e.g., "owner/repo")'),
      }),
    },
    async ({ commit, repository }: { commit: string; repository: string }) => {
      try {
        const result = await client.errors.get(commit, repository);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
