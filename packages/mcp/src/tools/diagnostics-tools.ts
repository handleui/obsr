/**
 * Diagnostics MCP Tools
 */

import type { DetectedTool, DetentClient, DiagnosticMode } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

// Define schema outside to simplify type inference
const parseLogsSchema = {
  content: z.string().describe("Raw CI/build log content"),
  tool: z
    .enum(["eslint", "vitest", "typescript", "cargo", "golangci"])
    .optional()
    .describe("Hint for parser (auto-detected if omitted)"),
  mode: z
    .enum(["full", "lite"])
    .optional()
    .describe("Response detail level (defaults to full)"),
};

export const registerDiagnosticsTools = (
  server: McpServer,
  client: DetentClient
) => {
  server.registerTool(
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
      inputSchema: parseLogsSchema,
    },
    // @ts-expect-error - MCP SDK type inference is too complex for TypeScript
    async (args: {
      content: string;
      tool?: "eslint" | "vitest" | "typescript" | "cargo" | "golangci";
      mode?: "full" | "lite";
    }): Promise<CallToolResult> => {
      try {
        const result = await client.diagnostics.parse(args.content, {
          tool: args.tool as DetectedTool | undefined,
          mode: args.mode as DiagnosticMode | undefined,
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
