/**
 * Braintrust tracing utilities for eval and development.
 *
 * This module provides optional tracing that only activates when
 * BRAINTRUST_API_KEY is set. It wraps HealLoop runs with Braintrust
 * spans for observability.
 *
 * Note: braintrust is a devDependency, so this should only be used
 * in eval/development contexts, not production builds.
 *
 * SECURITY NOTE: Logged data is sanitized to prevent sensitive information
 * (like API keys, tokens, passwords) from being sent to Braintrust.
 */

import { initLogger, traced } from "braintrust";
import type { HealResult } from "../types.js";

/**
 * Factory functions that create fresh regex instances for sensitive patterns.
 * These are redacted before sending to Braintrust.
 *
 * IMPORTANT: We use factory functions instead of regex literals because the
 * global flag (`g`) makes regexes stateful via `lastIndex`. While `String.replace`
 * doesn't persist this state, using factories prevents subtle bugs if patterns
 * are ever used with `test()` or `exec()`, and makes the code more maintainable.
 *
 * Note: Patterns are designed to avoid false positives on known-safe values
 * like git SHAs (40-char lowercase hex), UUIDs (36-char with dashes), and
 * content hashes commonly used in build tools.
 */
const SENSITIVE_PATTERN_FACTORIES: Array<() => RegExp> = [
  // API keys and tokens (common formats with explicit key/token indicators)
  () =>
    /(?:api[_-]?key|token|secret|password|auth|credential)s?\s*[:=]\s*['"]?[\w\-./+=]{20,}['"]?/gi,
  // Bearer tokens
  () => /Bearer\s+[\w\-./+=]+/gi,
  // AWS-style keys (specific prefix pattern)
  () => /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g,
  // GitHub tokens (specific prefix pattern)
  () => /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  // Anthropic API keys
  () => /sk-ant-[A-Za-z0-9\-_]{40,}/g,
  // OpenAI API keys
  () => /sk-[A-Za-z0-9]{48,}/g,
  // Slack tokens
  () => /xox[baprs]-[A-Za-z0-9-]+/g,
  // Private keys (PEM format markers)
  () => /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
  // Base64 strings that are explicitly marked as secrets
  () =>
    /(?:secret|private|credential)[_-]?(?:key)?[:\s=]+[A-Za-z0-9+/]{40,}={0,2}/gi,
];

/**
 * Redacts potentially sensitive information from a string.
 */
const redactSensitive = (text: string): string => {
  let result = text;
  for (const createPattern of SENSITIVE_PATTERN_FACTORIES) {
    result = result.replace(createPattern(), "[REDACTED]");
  }
  return result;
};

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
      projectName: "Detent-Healing",
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
 * Wrap a HealLoop run with Braintrust tracing.
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
export const tracedRun = <T extends HealResult>(
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
      const sanitizedUserPrompt = redactSensitive(
        input.userPrompt.slice(0, MAX_PROMPT_LENGTH)
      );
      const sanitizedFinalMessage = redactSensitive(
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
    { name: "HealLoop.run" }
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
