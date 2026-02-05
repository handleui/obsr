/**
 * Heals MCP Tools
 */

import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

export const registerHealsTools = (server: McpServer, client: DetentClient) => {
  // HACK: Cast to simplified interface to avoid OOM during TypeScript compilation.
  // The MCP SDK's McpServer type has complex generic inference that exhausts memory
  // on large projects. This workaround provides type-safe method signatures without
  // the full type complexity. Revisit when @modelcontextprotocol/sdk improves types.
  const srv = server as unknown as {
    registerTool: (
      name: string,
      opts: { description: string; inputSchema: Record<string, unknown> },
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) => void;
  };

  // Note: MCP SDK validates args against inputSchema before invoking handlers.
  // Type casts below are safe because validation occurs at the framework level.

  srv.registerTool(
    "detent_list_heals",
    {
      description:
        "List AI healing attempts for a project. Returns heals with status, associated errors, and patches.",
      inputSchema: {
        project_id: z.string().describe("Project ID"),
      },
    },
    async (args) => {
      try {
        const { project_id } = args as { project_id: string };
        const result = await client.heals.list(project_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
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
      inputSchema: {
        heal_id: z.string().describe("Heal ID"),
      },
    },
    async (args) => {
      try {
        const { heal_id } = args as { heal_id: string };
        const result = await client.heals.get(heal_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
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
      inputSchema: {
        error_ids: z.array(z.string()).describe("Error IDs to heal"),
      },
    },
    async (args) => {
      try {
        const { error_ids } = args as { error_ids: string[] };
        const result = await client.heals.trigger(error_ids);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
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
      inputSchema: {
        heal_id: z.string().describe("Heal ID to apply"),
      },
    },
    async (args) => {
      try {
        const { heal_id } = args as { heal_id: string };
        const result = await client.heals.apply(heal_id);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
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
      inputSchema: {
        heal_id: z.string().describe("Heal ID to reject"),
        reason: z.string().optional().describe("Reason for rejection"),
      },
    },
    async (args) => {
      try {
        const { heal_id, reason } = args as {
          heal_id: string;
          reason?: string;
        };
        const result = await client.heals.reject(heal_id, reason);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
