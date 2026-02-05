import type { CIError, ErrorSource } from "@detent/types";
import { CIErrorSchema, ErrorSourceSchema } from "@detent/types";
import { tool } from "ai";
import { z } from "zod";

/**
 * Creates a register_error tool that invokes the callback for each error.
 * The tool validates input against CIErrorSchema.
 */
export const createRegisterErrorTool = (
  onError?: (error: CIError) => Promise<void>
) =>
  tool({
    description:
      "Register a CI error or warning found in the output. Call once per distinct error.",
    inputSchema: CIErrorSchema,
    execute: async (error) => {
      await onError?.(error);
      return { registered: true };
    },
  });

/**
 * Creates a set_detected_source tool that captures the primary CI tool.
 */
export const createSetDetectedSourceTool = (
  onSource: (source: ErrorSource) => void
) =>
  tool({
    description:
      "Set the primary CI tool that produced this output. Call after processing all errors.",
    inputSchema: z.object({
      source: ErrorSourceSchema.describe("The detected CI tool source"),
    }),
    execute: ({ source }) => {
      onSource(source);
      return { set: true };
    },
  });
