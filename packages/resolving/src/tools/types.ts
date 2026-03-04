import { type ZodTypeAny, z } from "zod";
import type { ToolContext } from "./context.js";

export interface ToolResult {
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

export const errorResult = (message: string): ToolResult => ({
  content: message,
  isError: true,
});

export const successResult = (content: string): ToolResult => ({
  content,
  isError: false,
});

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    ctx: ToolContext,
    input: unknown,
    abortSignal?: AbortSignal
  ) => Promise<ToolResult>;
}

export interface SchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

export class SchemaBuilder {
  private readonly properties: Record<string, SchemaProperty> = {};
  private readonly required: string[] = [];

  addString = (name: string, description: string): this => {
    this.properties[name] = { type: "string", description };
    this.required.push(name);
    return this;
  };

  addOptionalString = (name: string, description: string): this => {
    this.properties[name] = { type: "string", description };
    return this;
  };

  addInteger = (name: string, description: string): this => {
    this.properties[name] = { type: "integer", description };
    this.required.push(name);
    return this;
  };

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

  addEnum = (name: string, description: string, values: string[]): this => {
    this.properties[name] = { type: "string", description, enum: values };
    this.required.push(name);
    return this;
  };

  addOptionalEnum = (
    name: string,
    description: string,
    values: string[]
  ): this => {
    this.properties[name] = { type: "string", description, enum: values };
    return this;
  };

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

const buildEnumField = (
  definition: SchemaProperty,
  name: string
): ZodTypeAny => {
  if (!definition.enum || definition.enum.length === 0) {
    return z.any();
  }

  const allStrings = definition.enum.every((v) => typeof v === "string");
  if (!allStrings) {
    throw new Error(`Enum values for "${name}" must all be strings`);
  }

  return z.enum(definition.enum as [string, ...string[]]) as ZodTypeAny;
};

const buildTypeField = (type: string): ZodTypeAny => {
  switch (type) {
    case "string":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    default:
      return z.any();
  }
};

const applyFieldModifiers = (
  field: ZodTypeAny,
  definition: SchemaProperty,
  isRequired: boolean
): ZodTypeAny => {
  let modified = field;

  if (definition.description) {
    modified = modified.describe(definition.description);
  }

  const hasDefault = definition.default !== undefined;
  const isOptional = !isRequired || hasDefault;

  if (isOptional && !hasDefault) {
    modified = modified.optional();
  }

  if (hasDefault) {
    modified = modified.default(definition.default);
  }

  return modified;
};

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
      field = buildEnumField(definition, name);
    } else {
      field = buildTypeField(definition.type);
    }

    shape[name] = applyFieldModifiers(field, definition, required.has(name));
  }

  return z.object(shape);
};
