import type { DetentClient } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type SimplifiedMcpServer, wrapHandler } from "../utils/errors.js";

export const registerBillingTools = (
  server: McpServer,
  client: DetentClient
) => {
  const srv = server as unknown as SimplifiedMcpServer;

  srv.registerTool(
    "detent_get_usage",
    {
      description:
        "Get CI run usage summary for an organization (total, successful, and failed runs in the current billing period).",
      inputSchema: {
        organization_id: z.string().describe("Organization ID"),
      },
    },
    wrapHandler<{ organization_id: string }>(async ({ organization_id }) =>
      client.billing.getUsage(organization_id)
    )
  );

  srv.registerTool(
    "detent_get_credits",
    {
      description:
        "Get credit usage breakdown showing AI vs sandbox costs, total spend, and recent usage events.",
      inputSchema: {
        organization_id: z.string().describe("Organization ID"),
      },
    },
    wrapHandler<{ organization_id: string }>(async ({ organization_id }) =>
      client.billing.getCredits(organization_id)
    )
  );

  srv.registerTool(
    "detent_get_portal_url",
    {
      description:
        "Get the billing portal URL for an organization to manage subscriptions and payment methods.",
      inputSchema: {
        organization_id: z.string().describe("Organization ID"),
      },
    },
    wrapHandler<{ organization_id: string }>(async ({ organization_id }) =>
      client.billing.getPortalUrl(organization_id)
    )
  );
};
