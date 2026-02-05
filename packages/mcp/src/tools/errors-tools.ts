/**
 * Errors MCP Tools
 */

import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

export const registerErrorsTools = (
  server: McpServer,
  client: DetentClient
) => {
  server.registerTool(
    "detent_get_errors",
    {
      description: `Get CI errors for a specific commit in a repository.

Returns errors from failed CI runs including:
- File path, line, and column
- Error message and category
- Severity and source tool
- Associated workflow runs`,
      inputSchema: {
        commit: z.string().describe("Git commit SHA"),
        repository: z
          .string()
          .describe('Repository full name (e.g., "owner/repo")'),
      },
    },
    async (args: {
      commit: string;
      repository: string;
    }): Promise<CallToolResult> => {
      try {
        const result = await client.errors.get(args.commit, args.repository);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
