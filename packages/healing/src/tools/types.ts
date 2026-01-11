import { type ZodTypeAny, z } from "zod";
import type { ToolContext } from "./context.js";

/**
 * Result of a tool execution.
 */
export interface ToolResult {
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Creates an error result.
 */
export const errorResult = (message: string): ToolResult => ({
  content: message,
  isError: true,
});

/**
 * Creates a success result.
 */
export const successResult = (content: string): ToolResult => ({
  content,
  isError: false,
});

/**
 * Tool interface that all heal tools must implement.
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (ctx: ToolContext, input: unknown) => Promise<ToolResult>;
}

/**
 * JSON Schema property definition.
 */
export interface SchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

/**
 * Schema builder for constructing JSON schemas for tool inputs.
 */
export class SchemaBuilder {
  private readonly properties: Record<string, SchemaProperty> = {};
  private readonly required: string[] = [];

  /**
   * Adds a required string property.
   */
  addString = (name: string, description: string): this => {
    this.properties[name] = { type: "string", description };
    this.required.push(name);
    return this;
  };

  /**
   * Adds an optional string property.
   */
  addOptionalString = (name: string, description: string): this => {
    this.properties[name] = { type: "string", description };
    return this;
  };

  /**
   * Adds a required integer property.
   */
  addInteger = (name: string, description: string): this => {
    this.properties[name] = { type: "integer", description };
    this.required.push(name);
    return this;
  };

  /**
   * Adds an optional integer property with a default value.
   */
  addOptionalInteger = (
    name: string,
    description: string,
    defaultVal: number
  ): this => {
    this.properties[name] = {
      type: "integer",
      description,
      default: defaultVal,
    };
    return this;
  };

  /**
   * Adds a required enum property.
   */
  addEnum = (name: string, description: string, values: string[]): this => {
    this.properties[name] = { type: "string", description, enum: values };
    this.required.push(name);
    return this;
  };

  /**
   * Adds an optional enum property.
   */
  addOptionalEnum = (
    name: string,
    description: string,
    values: string[]
  ): this => {
    this.properties[name] = { type: "string", description, enum: values };
    return this;
  };

  /**
   * Builds the schema as a JSON schema map.
   */
  build = (): Record<string, unknown> => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: this.properties,
    };
    if (this.required.length > 0) {
      schema.required = this.required;
    }
    return schema;
  };
}

/**
 * Converts a JSON schema map to a Zod schema for tool definitions.
 */
export const schemaToZod = (schema: Record<string, unknown>): ZodTypeAny => {
  const normalized = schema as {
    type?: string;
    properties?: Record<string, SchemaProperty>;
    required?: string[];
  };

  if (normalized.type && normalized.type !== "object") {
    return z.object({});
  }

  const required = new Set(normalized.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};

  for (const [name, definition] of Object.entries(
    normalized.properties ?? {}
  )) {
    let field: ZodTypeAny;

    if (definition.enum && definition.enum.length > 0) {
      field = z.enum(definition.enum as [string, ...string[]]) as ZodTypeAny;
    } else {
      switch (definition.type) {
        case "string":
          field = z.string();
          break;
        case "integer":
          field = z.number().int();
          break;
        case "number":
          field = z.number();
          break;
        case "boolean":
          field = z.boolean();
          break;
        default:
          field = z.any();
      }
    }

    if (definition.description) {
      field = field.describe(definition.description);
    }

    const hasDefault = definition.default !== undefined;
    const isOptional = !required.has(name) || hasDefault;
    if (isOptional && !hasDefault) {
      field = field.optional();
    }

    if (hasDefault) {
      field = field.default(definition.default);
    }

    shape[name] = field;
  }

  return z.object(shape);
};
