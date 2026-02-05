/**
 * Heals MCP Tools
 */

import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

// Type escape for MCP SDK's complex registerTool generics
interface ServerWithRegisterTool {
  registerTool: CallableFunction;
}

export const registerHealsTools = (server: McpServer, client: DetentClient) => {
  const srv = server as unknown as ServerWithRegisterTool;

  srv.registerTool(
    "detent_list_heals",
    {
      description:
        "List AI healing attempts for a project. Returns heals with status, associated errors, and patches.",
      inputSchema: z.object({
        project_id: z.string().describe("Project ID"),
      }),
    },
    async ({ project_id }: { project_id: string }) => {
      try {
        const result = await client.heals.list(project_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  srv.registerTool(
    "detent_get_heal",
    {
      description:
        "Get details for a specific heal including the generated patch.",
      inputSchema: z.object({
        heal_id: z.string().describe("Heal ID"),
      }),
    },
    async ({ heal_id }: { heal_id: string }) => {
      try {
        const result = await client.heals.get(heal_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  srv.registerTool(
    "detent_trigger_heal",
    {
      description:
        "Trigger AI healing for specific CI errors. The healing process will analyze the errors and generate a fix patch.",
      inputSchema: z.object({
        error_ids: z.array(z.string()).describe("Error IDs to heal"),
      }),
    },
    async ({ error_ids }: { error_ids: string[] }) => {
      try {
        const result = await client.heals.trigger(error_ids);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  srv.registerTool(
    "detent_apply_heal",
    {
      description:
        "Apply a completed heal to the PR. Creates a commit with the generated fix patch.",
      inputSchema: z.object({
        heal_id: z.string().describe("Heal ID to apply"),
      }),
    },
    async ({ heal_id }: { heal_id: string }) => {
      try {
        const result = await client.heals.apply(heal_id);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  srv.registerTool(
    "detent_reject_heal",
    {
      description: "Reject a heal if the generated fix is not suitable.",
      inputSchema: z.object({
        heal_id: z.string().describe("Heal ID to reject"),
        reason: z.string().optional().describe("Reason for rejection"),
      }),
    },
    async ({ heal_id, reason }: { heal_id: string; reason?: string }) => {
      try {
        const result = await client.heals.reject(heal_id, reason);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
