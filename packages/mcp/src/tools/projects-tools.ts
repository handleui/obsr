/**
 * Projects MCP Tools
 */

import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

export const registerProjectsTools = (
  server: McpServer,
  client: DetentClient
) => {
  server.registerTool(
    "detent_list_projects",
    {
      description: `List all projects in a Detent organization.

Returns projects with:
- Project ID and handle
- Repository name and full name
- Organization details
- Creation timestamp`,
      inputSchema: {
        organization_id: z.string().describe("Organization ID"),
      },
    },
    async (args: { organization_id: string }): Promise<CallToolResult> => {
      try {
        const result = await client.projects.list(args.organization_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  server.registerTool(
    "detent_get_project",
    {
      description:
        "Get details for a specific project by ID. Returns full project details including organization info.",
      inputSchema: {
        project_id: z.string().describe("Project ID"),
      },
    },
    async (args: { project_id: string }): Promise<CallToolResult> => {
      try {
        const result = await client.projects.get(args.project_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  server.registerTool(
    "detent_lookup_project",
    {
      description: `Find a project by its GitHub repository name.

Use this when you have a repo name like "owner/repo" but not the project ID.`,
      inputSchema: {
        repo: z.string().describe('Repository full name (e.g., "owner/repo")'),
      },
    },
    async (args: { repo: string }): Promise<CallToolResult> => {
      try {
        const result = await client.projects.lookup(args.repo);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
