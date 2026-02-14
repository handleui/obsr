#!/usr/bin/env node

import { createClient } from "@detent/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerBillingTools } from "./tools/billing-tools.js";
import { registerErrorsTools } from "./tools/errors-tools.js";
import { registerHealsTools } from "./tools/heals-tools.js";
import { registerProjectsTools } from "./tools/projects-tools.js";
import { registerSettingsTools } from "./tools/settings-tools.js";

const resolveAuth = () => {
  const apiKey = process.env.DETENT_API_KEY;
  if (apiKey) {
    return { type: "apiKey" as const, token: apiKey };
  }

  const jwtToken = process.env.DETENT_JWT_TOKEN;
  if (jwtToken) {
    return { type: "jwt" as const, token: jwtToken };
  }

  throw new Error(
    "Missing authentication. Set DETENT_API_KEY or DETENT_JWT_TOKEN environment variable."
  );
};

const main = async () => {
  const server = new McpServer({ name: "detent", version: "0.1.0" });
  const client = createClient({
    baseUrl: process.env.DETENT_API_URL,
    auth: resolveAuth(),
  });

  registerProjectsTools(server, client);
  registerErrorsTools(server, client);
  registerHealsTools(server, client);
  registerBillingTools(server, client);
  registerSettingsTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Detent MCP server started");
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("Failed to start MCP server:", message);
  process.exit(1);
});
