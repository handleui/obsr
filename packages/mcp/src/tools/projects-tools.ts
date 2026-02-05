/**
 * Projects MCP Tools
 */

import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

export const registerProjectsTools = (
  server: McpServer,
  client: DetentClient
) => {
  // Cast to any to avoid complex type inference that causes OOM
  const srv = server as unknown as {
    registerTool: (
      name: string,
      opts: { description: string; inputSchema: Record<string, unknown> },
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) => void;
  };

  srv.registerTool(
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
    async (args) => {
      try {
        const { organization_id } = args as { organization_id: string };
        const result = await client.projects.list(organization_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
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
      inputSchema: {
        project_id: z.string().describe("Project ID"),
      },
    },
    async (args) => {
      try {
        const { project_id } = args as { project_id: string };
        const result = await client.projects.get(project_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
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
      inputSchema: {
        repo: z.string().describe('Repository full name (e.g., "owner/repo")'),
      },
    },
    async (args) => {
      try {
        const { repo } = args as { repo: string };
        const result = await client.projects.lookup(repo);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
