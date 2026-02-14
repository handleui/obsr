import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type SimplifiedMcpServer, wrapHandler } from "../utils/errors.js";

export const registerHealsTools = (server: McpServer, client: DetentClient) => {
  const srv = server as unknown as SimplifiedMcpServer;

  srv.registerTool(
    "detent_list_heals",
    {
      description:
        "List AI healing attempts for a project PR. Returns heals with status, type, cost, and patches.",
      inputSchema: {
        project_id: z.string().describe("Project ID"),
        pr_number: z.number().int().positive().describe("PR number"),
      },
    },
    wrapHandler<{ project_id: string; pr_number: number }>(
      async ({ project_id, pr_number }) =>
        client.heals.list(project_id, pr_number)
    )
  );

  srv.registerTool(
    "detent_get_pending_heals",
    {
      description: "Get pending heals for a project.",
      inputSchema: {
        project_id: z.string().describe("Project ID"),
      },
    },
    wrapHandler<{ project_id: string }>(async ({ project_id }) =>
      client.heals.pending(project_id)
    )
  );

  srv.registerTool(
    "detent_get_heal",
    {
      description:
        "Get details for a specific heal including the generated patch, cost, and token usage.",
      inputSchema: {
        heal_id: z.string().describe("Heal ID"),
      },
    },
    wrapHandler<{ heal_id: string }>(async ({ heal_id }) =>
      client.heals.get(heal_id)
    )
  );

  srv.registerTool(
    "detent_trigger_heal_by_pr",
    {
      description:
        "Trigger AI healing for all fixable errors on a PR. Creates heals from the latest CI run.",
      inputSchema: {
        project_id: z.string().describe("Project ID"),
        pr_number: z.number().int().positive().describe("PR number"),
        type: z
          .enum(["autofix", "heal"])
          .default("autofix")
          .describe("Type of healing: autofix (deterministic) or heal (AI)"),
      },
    },
    wrapHandler<{
      project_id: string;
      pr_number: number;
      type?: "autofix" | "heal";
    }>(async ({ project_id, pr_number, type }) =>
      client.heals.triggerByPr(project_id, pr_number, type)
    )
  );

  srv.registerTool(
    "detent_trigger_heal_by_id",
    {
      description: 'Trigger a specific heal by ID (must be in "found" status).',
      inputSchema: {
        heal_id: z.string().describe("Heal ID to trigger"),
      },
    },
    wrapHandler<{ heal_id: string }>(async ({ heal_id }) =>
      client.heals.triggerById(heal_id)
    )
  );

  srv.registerTool(
    "detent_apply_heal",
    {
      description:
        "Apply a completed heal to the PR. Creates a commit with the generated fix.",
      inputSchema: {
        heal_id: z.string().describe("Heal ID to apply"),
      },
    },
    wrapHandler<{ heal_id: string }>(async ({ heal_id }) =>
      client.heals.apply(heal_id)
    )
  );

  srv.registerTool(
    "detent_reject_heal",
    {
      description: "Reject a heal if the generated fix is not suitable.",
      inputSchema: {
        heal_id: z.string().describe("Heal ID to reject"),
        reason: z.string().optional().describe("Reason for rejection"),
      },
    },
    wrapHandler<{ heal_id: string; reason?: string }>(
      async ({ heal_id, reason }) => client.heals.reject(heal_id, reason)
    )
  );
};
