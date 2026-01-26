import { detectToolFromCommand, type ToolConfig } from "./tools.js";

export interface PreparedCommand {
  command: string;
  tool: ToolConfig["parser"] | null;
  outputSource: "stdout" | "stderr";
}

const FLAG_PREFIXES = [
  "--reporter",
  "--format",
  "--out-format",
  "--message-format",
];

/**
 * Prepare a command for execution with diagnostic parsing.
 *
 * - Detects the tool from the command string
 * - Injects JSON output flags if needed (and no conflicting flags present)
 * - Returns info needed to parse the output
 *
 * @example
 * ```ts
 * const prepared = prepareCommand("bun run test")
 * // {
 * //   command: "bun run test --reporter json",
 * //   tool: "vitest",
 * //   outputSource: "stdout"
 * // }
 * ```
 */
export const prepareCommand = (command: string): PreparedCommand => {
  const config = detectToolFromCommand(command);

  if (!config || config.jsonFlags.length === 0) {
    return {
      command,
      tool: config?.parser ?? null,
      outputSource: config?.outputSource ?? "stdout",
    };
  }

  const hasConflict = FLAG_PREFIXES.some((p) =>
    new RegExp(`\\s${p}(?:=|\\s|$)`).test(command)
  );
  if (hasConflict) {
    return {
      command,
      tool: config.parser,
      outputSource: config.outputSource,
    };
  }

  const injected = `${command} ${config.jsonFlags.join(" ")}`;
  return {
    command: injected,
    tool: config.parser,
    outputSource: config.outputSource,
  };
};
