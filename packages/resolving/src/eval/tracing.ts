/**
 * Braintrust tracing utilities for eval and development.
 *
 * This module provides optional tracing that only activates when
 * BRAINTRUST_API_KEY is set. It wraps ResolveLoop runs with Braintrust
 * spans for observability.
 *
 * Note: braintrust is a devDependency, so this should only be used
 * in eval/development contexts, not production builds.
 *
 * SECURITY NOTE: Logged data is sanitized to prevent sensitive information
 * (like API keys, tokens, passwords) from being sent to Braintrust.
 */

import { redactSensitiveData } from "@detent/types";
import { initLogger, traced } from "braintrust";
import type { ResolveResult } from "../types.js";

/**
 * Maximum length for logged prompts to prevent excessive data transfer.
 */
const MAX_PROMPT_LENGTH = 2000;

let logger: ReturnType<typeof initLogger> | null = null;

/**
 * Initialize Braintrust logger if API key is available.
 * Call this once at the start of your eval run.
 */
export const initTracing = (): boolean => {
  if (!process.env.BRAINTRUST_API_KEY) {
    return false;
  }

  if (!logger) {
    logger = initLogger({
      projectName: "Detent-Resolving",
      apiKey: process.env.BRAINTRUST_API_KEY,
    });
  }

  return true;
};

/**
 * Check if tracing is enabled.
 */
export const isTracingEnabled = (): boolean => {
  return logger !== null;
};

interface TracedRunInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  budgetPerRunUSD: number;
}

interface TracedRunMetadata {
  testCaseId?: string;
  tags?: string[];
}

/**
 * Wrap a ResolveLoop run with Braintrust tracing.
 *
 * Usage:
 * ```typescript
 * const result = await tracedRun(
 *   { systemPrompt, userPrompt, model, budgetPerRunUSD },
 *   () => loop.run(systemPrompt, userPrompt),
 *   { testCaseId: 'ts-undefined-property' }
 * );
 * ```
 */
export const tracedRun = <T extends ResolveResult>(
  input: TracedRunInput,
  runFn: () => Promise<T>,
  metadata?: TracedRunMetadata
): Promise<T> => {
  // If tracing not enabled, just run the function
  if (!logger) {
    return runFn();
  }

  return traced(
    async (span) => {
      const result = await runFn();

      // Truncate and redact sensitive information before logging
      const sanitizedUserPrompt = redactSensitiveData(
        input.userPrompt.slice(0, MAX_PROMPT_LENGTH)
      );
      const sanitizedFinalMessage = redactSensitiveData(
        result.finalMessage.slice(0, MAX_PROMPT_LENGTH)
      );

      span.log({
        input: {
          systemPrompt: `${input.systemPrompt.slice(0, 500)}...`,
          userPrompt: sanitizedUserPrompt,
        },
        output: {
          success: result.success,
          finalMessage: sanitizedFinalMessage,
        },
        metrics: {
          iterations: result.iterations,
          tool_calls: result.toolCalls,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          cost_usd: result.costUSD,
          duration_ms: result.duration,
        },
        metadata: {
          model: input.model,
          budget_per_run_usd: input.budgetPerRunUSD,
          test_case_id: metadata?.testCaseId,
          tags: metadata?.tags,
        },
      });

      return result;
    },
    { name: "ResolveLoop.run" }
  );
};

/**
 * Log a standalone event (not tied to a span).
 */
export const logEvent = (event: {
  name: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
}): void => {
  if (!logger) {
    return;
  }

  logger.log({
    input: event.input,
    output: event.output,
    metrics: event.metrics,
    metadata: {
      event_name: event.name,
      ...event.metadata,
    },
  });
};
