import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type SimplifiedMcpServer, wrapHandler } from "../utils/errors.js";

export const registerErrorsTools = (
  server: McpServer,
  client: DetentClient
) => {
  const srv = server as unknown as SimplifiedMcpServer;

  srv.registerTool(
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
    wrapHandler<{ commit: string; repository: string }>(
      async ({ commit, repository }) => client.errors.get(commit, repository)
    )
  );
};
