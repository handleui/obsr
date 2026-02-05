/**
 * Diagnostics MCP Tools
 */

import type { DetectedTool, DetentClient, DiagnosticMode } from "@detent/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatErrorResponse } from "../utils/errors.js";

// Type escape for MCP SDK's complex registerTool generics
interface ServerWithRegisterTool {
  registerTool: CallableFunction;
}

export const registerDiagnosticsTools = (
  server: McpServer,
  client: DetentClient
) => {
  const srv = server as unknown as ServerWithRegisterTool;

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
      inputSchema: z.object({
        content: z.string().describe("Raw CI/build log content"),
        tool: z
          .enum(["eslint", "vitest", "typescript", "cargo", "golangci"])
          .optional()
          .describe("Hint for parser (auto-detected if omitted)"),
        mode: z
          .enum(["full", "lite"])
          .optional()
          .describe("Response detail level (defaults to full)"),
      }),
    },
    async ({
      content,
      tool,
      mode,
    }: {
      content: string;
      tool?: string;
      mode?: string;
    }) => {
      try {
        const result = await client.diagnostics.parse(content, {
          tool: tool as DetectedTool | undefined,
          mode: mode as DiagnosticMode | undefined,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return formatErrorResponse(error);
      }
    }
  );
};
