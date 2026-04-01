import { redactSensitiveData } from "@obsr/types";
import { type Tool as AiSdkTool, tool as aiTool } from "ai";
import type { ToolContext } from "./context.js";
import {
  errorResult,
  schemaToZod,
  type Tool,
  type ToolResult,
} from "./types.js";

export const DEFAULT_TOOL_LIMITS: Record<string, number> = {
  run_command: 100,
  run_check: 100,
  edit_file: 200,
  read_file: 500,
  glob: 200,
  grep: 200,
};

const MAX_LOG_ENTRIES = 100;
const MAX_COMMAND_LENGTH = 200;

const coerceToRecord = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};

export interface CommandLogEntry {
  tool: string;
  durationMs: number;
  isError: boolean;
  timestamp: number;
  step: number;
  command?: string;
  exitCode?: number;
  outputBytes?: number;
}

export class ToolRegistry {
  private readonly tools: Map<string, Tool> = new Map();
  private readonly ctx: ToolContext;
  private readonly callCounts: Map<string, number> = new Map();
  private readonly commandLog: CommandLogEntry[] = [];
  private readonly toolLimits: Record<string, number>;
  private cachedAiTools: Record<string, AiSdkTool<unknown, ToolOutput>> | null =
    null;
  private toolCallListener:
    | ((name: string, input: Record<string, unknown>) => void)
    | null = null;
  private _currentStep = 0;

  constructor(ctx: ToolContext, toolLimits?: Record<string, number>) {
    this.ctx = ctx;
    this.toolLimits = toolLimits ?? DEFAULT_TOOL_LIMITS;
  }

  register = (tool: Tool): void => {
    this.tools.set(tool.name, tool);
    this.cachedAiTools = null;
  };

  registerAll = (tools: Tool[]): void => {
    for (const tool of tools) {
      this.register(tool);
    }
  };

  get = (name: string): Tool | undefined => this.tools.get(name);

  has = (name: string): boolean => this.tools.has(name);

  private readonly pushLog = (
    tool: string,
    startTime: number,
    isError: boolean,
    extras?: { command?: string; exitCode?: number; outputBytes?: number }
  ): void => {
    if (this.commandLog.length >= MAX_LOG_ENTRIES) {
      this.commandLog.shift();
    }
    this.commandLog.push({
      tool,
      durationMs: Date.now() - startTime,
      isError,
      timestamp: startTime,
      step: this._currentStep,
      ...extras,
    });
  };

  private readonly buildLogExtras = (
    input: unknown,
    result: ToolResult
  ): { command?: string; exitCode?: number; outputBytes?: number } => {
    const inputRecord = coerceToRecord(input);
    const rawCommand =
      typeof inputRecord.command === "string" ? inputRecord.command : undefined;
    return {
      command: rawCommand
        ? redactSensitiveData(rawCommand).slice(0, MAX_COMMAND_LENGTH)
        : undefined,
      exitCode:
        typeof result.metadata?.exitCode === "number"
          ? result.metadata.exitCode
          : undefined,
      outputBytes: result.content.length,
    };
  };

  dispatch = async (
    name: string,
    input: unknown,
    abortSignal?: AbortSignal
  ): Promise<ToolResult> => {
    const tool = this.tools.get(name);
    if (!tool) {
      return errorResult(`unknown tool: ${name}`);
    }

    const limitExceeded = this.checkAndUpdateLimit(name);
    if (limitExceeded) {
      return limitExceeded;
    }

    const startTime = Date.now();
    if (abortSignal?.aborted) {
      return errorResult(`tool call aborted before execution: ${name}`);
    }

    try {
      const result = await tool.execute(this.ctx, input, abortSignal);
      this.pushLog(
        name,
        startTime,
        result.isError,
        this.buildLogExtras(input, result)
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const safeMessage = redactSensitiveData(message);
      this.pushLog(name, startTime, true);
      return errorResult(`tool execution failed: ${safeMessage}`);
    }
  };

  private readonly checkAndUpdateLimit = (name: string): ToolResult | null => {
    const limit = this.toolLimits[name];
    if (limit === undefined) {
      this.callCounts.set(name, (this.callCounts.get(name) ?? 0) + 1);
      return null;
    }

    const currentCount = this.callCounts.get(name) ?? 0;
    const newCount = currentCount + 1;
    if (newCount > limit) {
      return errorResult(`tool call limit for ${name} (${limit}) exceeded`);
    }
    this.callCounts.set(name, newCount);
    return null;
  };

  setToolCallListener = (
    listener: ((name: string, input: Record<string, unknown>) => void) | null
  ): void => {
    this.toolCallListener = listener;
  };

  private readonly wrapTool = (tool: Tool): AiSdkTool<unknown, ToolOutput> =>
    aiTool({
      description: tool.description,
      inputSchema: schemaToZod(tool.inputSchema),
      execute: async (
        input: unknown,
        options?: { abortSignal?: AbortSignal }
      ) => {
        const safeInput = coerceToRecord(input);
        this.toolCallListener?.(tool.name, safeInput);
        const result = await this.dispatch(
          tool.name,
          input,
          options?.abortSignal
        );
        return formatToolResult(result);
      },
    });

  toAiTools = (): Record<string, AiSdkTool<unknown, ToolOutput>> => {
    if (this.cachedAiTools) {
      return this.cachedAiTools;
    }

    const tools: Record<string, AiSdkTool<unknown, ToolOutput>> = {};
    for (const tool of this.tools.values()) {
      tools[tool.name] = this.wrapTool(tool);
    }

    this.cachedAiTools = tools;
    return this.cachedAiTools;
  };

  get currentStep(): number {
    return this._currentStep;
  }

  set currentStep(step: number) {
    this._currentStep = Math.max(0, Math.min(step, 1000));
  }

  get callStats(): { total: number; byTool: Record<string, number> } {
    return {
      total: Array.from(this.callCounts.values()).reduce((a, b) => a + b, 0),
      byTool: Object.fromEntries(this.callCounts),
    };
  }

  get auditLog(): CommandLogEntry[] {
    return [...this.commandLog];
  }

  get size(): number {
    return this.tools.size;
  }

  get names(): string[] {
    return Array.from(this.tools.keys());
  }
}

export const createToolRegistry = (
  ctx: ToolContext,
  toolLimits?: Record<string, number>
): ToolRegistry => new ToolRegistry(ctx, toolLimits);

const formatToolResult = (
  result: ToolResult
): Record<string, unknown> | string => {
  if (!(result.isError || result.metadata)) {
    return result.content;
  }

  const payload: Record<string, unknown> = {
    content: result.content,
  };

  if (result.isError) {
    payload.is_error = true;
  }
  if (result.metadata) {
    payload.metadata = result.metadata;
  }

  return payload;
};

type ToolOutput = string | Record<string, unknown>;
