import type { ToolContext } from "./context.js";
import { executeCommand, parseCommand, validateCommand } from "./execute.js";
import { errorResult, type Tool, type ToolResult } from "./types.js";

export const runCheckTool: Tool = {
  name: "run_check",
  description:
    "Re-run the failing CI command to verify your fix works. Call this after editing files to confirm the error is resolved.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },

  execute: async (
    ctx: ToolContext,
    _input: unknown,
    abortSignal?: AbortSignal
  ): Promise<ToolResult> => {
    if (!ctx.failingStep) {
      return errorResult("no failing step context available");
    }

    if (!ctx.stepCommands) {
      return errorResult("no step commands available");
    }

    const { jobId, stepIndex } = ctx.failingStep;
    const jobCommands = ctx.stepCommands.get(jobId);

    if (!jobCommands) {
      return errorResult(`job "${jobId}" not found in step commands`);
    }

    if (stepIndex < 0 || stepIndex >= jobCommands.length) {
      return errorResult(
        `step index ${stepIndex} out of range for job "${jobId}"`
      );
    }

    const command = jobCommands[stepIndex];
    if (!command) {
      return errorResult(
        "step does not have a run command (uses action instead)"
      );
    }

    const validationError = validateCommand(command);
    if (validationError) {
      return errorResult(validationError);
    }

    const { normalized, parts } = parseCommand(command);
    if (parts.length === 0) {
      return errorResult("empty command");
    }

    return await executeCommand(
      ctx.worktreePath,
      normalized,
      parts,
      abortSignal
    );
  },
};
