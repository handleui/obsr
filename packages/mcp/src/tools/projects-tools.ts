import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type SimplifiedMcpServer, wrapHandler } from "../utils/errors.js";

export const registerProjectsTools = (
  server: McpServer,
  client: DetentClient
) => {
  const srv = server as unknown as SimplifiedMcpServer;

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
    wrapHandler<{ organization_id: string }>(async ({ organization_id }) =>
      client.projects.list(organization_id)
    )
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
    wrapHandler<{ project_id: string }>(async ({ project_id }) =>
      client.projects.get(project_id)
    )
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
    wrapHandler<{ repo: string }>(async ({ repo }) =>
      client.projects.lookup(repo)
    )
  );
};
