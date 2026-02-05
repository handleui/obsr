/**
 * Projects MCP Tools
 */

import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

// Type escape for MCP SDK's complex registerTool generics
interface ServerWithRegisterTool {
  registerTool: CallableFunction;
}

export const registerProjectsTools = (
  server: McpServer,
  client: DetentClient
) => {
  const srv = server as unknown as ServerWithRegisterTool;

  srv.registerTool(
    "detent_list_projects",
    {
      description: `List all projects in a Detent organization.

Returns projects with:
- Project ID and handle
- Repository name and full name
- Organization details
- Creation timestamp`,
      inputSchema: z.object({
        organization_id: z.string().describe("Organization ID"),
      }),
    },
    async ({ organization_id }: { organization_id: string }) => {
      try {
        const result = await client.projects.list(organization_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  srv.registerTool(
    "detent_get_project",
    {
      description:
        "Get details for a specific project by ID. Returns full project details including organization info.",
      inputSchema: z.object({
        project_id: z.string().describe("Project ID"),
      }),
    },
    async ({ project_id }: { project_id: string }) => {
      try {
        const result = await client.projects.get(project_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  srv.registerTool(
    "detent_lookup_project",
    {
      description: `Find a project by its GitHub repository name.

Use this when you have a repo name like "owner/repo" but not the project ID.`,
      inputSchema: z.object({
        repo: z.string().describe('Repository full name (e.g., "owner/repo")'),
      }),
    },
    async ({ repo }: { repo: string }) => {
      try {
        const result = await client.projects.lookup(repo);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
