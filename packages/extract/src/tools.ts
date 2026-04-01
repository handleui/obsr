import type { CIError, ErrorSource } from "@obsr/types";
import { CIErrorSchema, ErrorSourceSchema } from "@obsr/types";
import { tool } from "ai";
import { z } from "zod";

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
