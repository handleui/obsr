#!/usr/bin/env node

import { createClient, type DetentClient } from "@detent/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerErrorsTools } from "./tools/errors-tools.js";
import { registerHealsTools } from "./tools/heals-tools.js";
import { registerProjectsTools } from "./tools/projects-tools.js";

const main = async () => {
  const server = new McpServer({
    name: "detent",
    version: "0.1.0",
  });

  const apiKey = process.env.DETENT_API_KEY;
  const jwtToken = process.env.DETENT_JWT_TOKEN;
  const baseUrl = process.env.DETENT_API_URL;

  let client: DetentClient;
  if (apiKey) {
    client = createClient({
      baseUrl,
      auth: { type: "apiKey", token: apiKey },
    });
  } else if (jwtToken) {
    client = createClient({
      baseUrl,
      auth: { type: "jwt", token: jwtToken },
    });
  } else {
    throw new Error(
      "Missing authentication. Set DETENT_API_KEY or DETENT_JWT_TOKEN environment variable."
    );
  }

  registerProjectsTools(server, client);
  registerErrorsTools(server, client);
  registerHealsTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Detent MCP server started");
};

main().catch((error) => {
  // Avoid logging the full error object as it may contain sensitive info
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("Failed to start MCP server:", message);
  process.exit(1);
});
