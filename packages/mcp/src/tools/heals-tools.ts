/**
 * Heals MCP Tools
 */

import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

// Define schemas outside to simplify type inference
const listHealsSchema = { project_id: z.string().describe("Project ID") };
const getHealSchema = { heal_id: z.string().describe("Heal ID") };
const triggerHealSchema = {
  error_ids: z.array(z.string()).describe("Error IDs to heal"),
};
const applyHealSchema = { heal_id: z.string().describe("Heal ID to apply") };
const rejectHealSchema = {
  heal_id: z.string().describe("Heal ID to reject"),
  reason: z.string().optional().describe("Reason for rejection"),
};

export const registerHealsTools = (server: McpServer, client: DetentClient) => {
  server.registerTool(
    "detent_list_heals",
    {
      description:
        "List AI healing attempts for a project. Returns heals with status, associated errors, and patches.",
      inputSchema: listHealsSchema,
    },
    async (args: { project_id: string }): Promise<CallToolResult> => {
      try {
        const result = await client.heals.list(args.project_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  server.registerTool(
    "detent_get_heal",
    {
      description:
        "Get details for a specific heal including the generated patch.",
      inputSchema: getHealSchema,
    },
    async (args: { heal_id: string }): Promise<CallToolResult> => {
      try {
        const result = await client.heals.get(args.heal_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  server.registerTool(
    "detent_trigger_heal",
    {
      description:
        "Trigger AI healing for specific CI errors. The healing process will analyze the errors and generate a fix patch.",
      inputSchema: triggerHealSchema,
    },
    async (args: { error_ids: string[] }): Promise<CallToolResult> => {
      try {
        const result = await client.heals.trigger(args.error_ids);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  server.registerTool(
    "detent_apply_heal",
    {
      description:
        "Apply a completed heal to the PR. Creates a commit with the generated fix patch.",
      inputSchema: applyHealSchema,
    },
    async (args: { heal_id: string }): Promise<CallToolResult> => {
      try {
        const result = await client.heals.apply(args.heal_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );

  server.registerTool(
    "detent_reject_heal",
    {
      description: "Reject a heal if the generated fix is not suitable.",
      inputSchema: rejectHealSchema,
    },
    // @ts-expect-error - MCP SDK type inference is too complex for TypeScript
    async (args: {
      heal_id: string;
      reason?: string;
    }): Promise<CallToolResult> => {
      try {
        const result = await client.heals.reject(args.heal_id, args.reason);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
