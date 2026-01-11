import { type Tool as AiSdkTool, tool as aiTool } from "ai";
import type { ToolContext } from "./context.js";
import {
  errorResult,
  schemaToZod,
  type Tool,
  type ToolResult,
} from "./types.js";

/**
 * Registry for managing and dispatching tools.
 */
export class ToolRegistry {
  private readonly tools: Map<string, Tool> = new Map();
  private readonly ctx: ToolContext;
  private cachedAiTools: Record<string, AiSdkTool<unknown, ToolOutput>> | null =
    null;
  private toolCallListener:
    | ((name: string, input: Record<string, unknown>) => void)
    | null = null;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  /**
   * Registers a tool with the registry.
   */
  register = (tool: Tool): void => {
    this.tools.set(tool.name, tool);
    this.cachedAiTools = null;
  };

  /**
   * Registers multiple tools at once.
   */
  registerAll = (tools: Tool[]): void => {
    for (const tool of tools) {
      this.register(tool);
    }
  };

  /**
   * Gets a tool by name.
   */
  get = (name: string): Tool | undefined => this.tools.get(name);

  /**
   * Checks if a tool exists.
   */
  has = (name: string): boolean => this.tools.has(name);

  /**
   * Dispatches a tool call by name with the given input.
   */
  dispatch = async (name: string, input: unknown): Promise<ToolResult> => {
    const tool = this.tools.get(name);
    if (!tool) {
      return errorResult(`unknown tool: ${name}`);
    }

    try {
      return await tool.execute(this.ctx, input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`tool execution failed: ${message}`);
    }
  };

  /**
   * Sets a listener for tool calls (used for verbose logging).
   */
  setToolCallListener = (
    listener: ((name: string, input: Record<string, unknown>) => void) | null
  ): void => {
    this.toolCallListener = listener;
  };

  /**
   * Converts registered tools to AI SDK format.
   * Results are cached until a new tool is registered.
   */
  toAiTools = (): Record<string, AiSdkTool<unknown, ToolOutput>> => {
    if (this.cachedAiTools) {
      return this.cachedAiTools;
    }

    const tools: Record<string, AiSdkTool<unknown, ToolOutput>> = {};

    for (const tool of this.tools.values()) {
      tools[tool.name] = aiTool({
        description: tool.description,
        inputSchema: schemaToZod(tool.inputSchema),
        execute: async (input: unknown) => {
          const safeInput =
            typeof input === "object" && input !== null
              ? (input as Record<string, unknown>)
              : {};
          this.toolCallListener?.(tool.name, safeInput);
          const result = await this.dispatch(tool.name, input);
          return formatToolResult(result);
        },
      });
    }

    this.cachedAiTools = tools;
    return this.cachedAiTools;
  };

  /**
   * Returns the number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Returns all tool names.
   */
  get names(): string[] {
    return Array.from(this.tools.keys());
  }
}

/**
 * Creates a new tool registry with the given context.
 */
export const createToolRegistry = (ctx: ToolContext): ToolRegistry =>
  new ToolRegistry(ctx);

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
