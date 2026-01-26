import type { Parser } from "./types.js";

export interface ToolConfig {
  /** Regex to detect tool in command string */
  commandPattern: RegExp;
  /** Flags to inject for JSON output (e.g., ["--format", "json"]) */
  jsonFlags: readonly string[];
  /** Where JSON output appears */
  outputSource: "stdout" | "stderr";
  /** Parser name - built-in (e.g., "eslint") or custom registered via registerParser() */
  parser: string;
}

export interface CustomToolConfig {
  /** Unique name for this tool (used to reference the parser) */
  name: string;
  /** Regex to detect tool in command string */
  commandPattern: RegExp;
  /** Flags to inject for JSON output (e.g., ["--format", "json"]) */
  jsonFlags: readonly string[];
  /** Where JSON output appears */
  outputSource: "stdout" | "stderr";
  /** Parser function that extracts diagnostics from tool output */
  parse: Parser;
}

const TOOL_CONFIGS: ToolConfig[] = [
  {
    commandPattern: /vitest|bun\s+test/,
    jsonFlags: ["--reporter", "json"],
    outputSource: "stdout",
    parser: "vitest",
  },
  {
    commandPattern: /eslint/,
    jsonFlags: ["--format", "json"],
    outputSource: "stdout",
    parser: "eslint",
  },
  {
    commandPattern: /\btsc\b/,
    jsonFlags: [],
    outputSource: "stdout",
    parser: "typescript",
  },
  {
    commandPattern: /cargo\s+(build|check|clippy|test)/,
    jsonFlags: ["--message-format=json"],
    outputSource: "stdout",
    parser: "cargo",
  },
  {
    commandPattern: /golangci-lint/,
    jsonFlags: ["--out-format=json"],
    outputSource: "stdout",
    parser: "golangci",
  },
];

const toolConfigRegistry: ToolConfig[] = [...TOOL_CONFIGS];

export const detectToolFromCommand = (command: string): ToolConfig | null => {
  for (const config of toolConfigRegistry) {
    if (config.commandPattern.test(command)) {
      return config;
    }
  }
  return null;
};

export const registerToolConfig = (config: ToolConfig): void => {
  toolConfigRegistry.unshift(config);
};

/**
 * Register a custom tool with both command detection and parser in one call.
 *
 * @example
 * ```ts
 * registerTool({
 *   name: "pytest",
 *   commandPattern: /pytest/,
 *   jsonFlags: ["--json-report"],
 *   outputSource: "stdout",
 *   parse: (content) => {
 *     const data = JSON.parse(content)
 *     return data.tests.filter(t => t.outcome === "failed").map(t => ({
 *       message: t.longrepr,
 *       filePath: t.nodeid,
 *       severity: "error"
 *     }))
 *   }
 * })
 * ```
 */
export const registerTool = async (config: CustomToolConfig): Promise<void> => {
  const { registerParser } = await import("./extract.js");
  registerParser(config.name, config.parse);
  toolConfigRegistry.unshift({
    commandPattern: config.commandPattern,
    jsonFlags: config.jsonFlags,
    outputSource: config.outputSource,
    parser: config.name,
  });
};
