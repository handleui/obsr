/**
 * Diagnostics MCP Tools
 */

import type { DetectedTool, DetentClient, DiagnosticMode } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

export const registerDiagnosticsTools = (
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
    "detent_parse_logs",
    {
      description: `Parse CI/build logs into structured diagnostics.

Extracts errors and warnings from raw CI output with file locations,
severity, and tool-specific metadata. Supports ESLint, TypeScript,
Vitest, Cargo, and golangci-lint.

Returns diagnostics with:
- File path, line, and column numbers
- Error/warning severity
- Rule IDs and hints
- Summary counts`,
      inputSchema: {
        content: z.string().describe("Raw CI/build log content"),
        tool: z
          .enum(["eslint", "vitest", "typescript", "cargo", "golangci"])
          .optional()
          .describe("Hint for parser (auto-detected if omitted)"),
        mode: z
          .enum(["full", "lite"])
          .optional()
          .describe("Response detail level (defaults to full)"),
      },
    },
    async (args) => {
      try {
        const { content, tool, mode } = args as {
          content: string;
          tool?: string;
          mode?: string;
        };
        const result = await client.diagnostics.parse(content, {
          tool: tool as DetectedTool | undefined,
          mode: mode as DiagnosticMode | undefined,
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
