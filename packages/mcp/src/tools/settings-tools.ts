import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type SimplifiedMcpServer, wrapHandler } from "../utils/errors.js";

export const registerSettingsTools = (
  server: McpServer,
  client: DetentClient
) => {
  const srv = server as unknown as SimplifiedMcpServer;

  srv.registerTool(
    "detent_get_org_status",
    {
      description:
        "Get organization status including settings, project count, GitHub sync state, and installation status.",
      inputSchema: {
        organization_id: z.string().describe("Organization ID"),
      },
    },
    wrapHandler<{ organization_id: string }>(async ({ organization_id }) =>
      client.organizations.getStatus(organization_id)
    )
  );

  srv.registerTool(
    "detent_update_settings",
    {
      description:
        "Update organization settings like PR comments, inline annotations, auto-healing, and validation.",
      inputSchema: {
        organization_id: z.string().describe("Organization ID"),
        enable_inline_annotations: z
          .boolean()
          .optional()
          .describe("Enable inline error annotations on PRs"),
        enable_pr_comments: z
          .boolean()
          .optional()
          .describe("Enable PR comment summaries"),
        heal_auto_trigger: z
          .boolean()
          .optional()
          .describe("Automatically trigger healing on CI failures"),
        validation_enabled: z
          .boolean()
          .optional()
          .describe("Enable heal validation before applying"),
      },
    },
    wrapHandler<{
      organization_id: string;
      enable_inline_annotations?: boolean;
      enable_pr_comments?: boolean;
      heal_auto_trigger?: boolean;
      validation_enabled?: boolean;
    }>(async ({ organization_id, ...settings }) =>
      client.settings.update(organization_id, settings)
    )
  );
};
