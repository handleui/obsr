/**
 * Braintrust evaluation runner for the healing loop.
 *
 * Run with: bun run eval
 *
 * Environment variables:
 * - BRAINTRUST_API_KEY: Required for logging to Braintrust
 * - AI_GATEWAY_API_KEY: Required for running actual healing loops (live mode)
 * - ANTHROPIC_API_KEY: Optional BYOK key for Anthropic via the AI Gateway
 * - EVAL_MODE: "mock" (default) or "live" - controls whether to use real API calls
 */

if (!process.env.BRAINTRUST_API_KEY) {
  console.error("Error: BRAINTRUST_API_KEY environment variable is required.");
  console.error(
    "Get your API key from: https://www.braintrust.dev/app/settings"
  );
  console.error("\nRun with:");
  console.error("  export BRAINTRUST_API_KEY='your-key-here'");
  console.error("  bun run eval");
  process.exit(1);
}

import { Eval } from "braintrust";
import { Client } from "../client.js";
import { HealLoop } from "../loop.js";
import { SYSTEM_PROMPT } from "../prompt/system.js";
import {
  createToolContext,
  createToolRegistry,
  getAllTools,
} from "../tools/index.js";
import { HEALING_DATASET } from "./dataset.js";
import {
  codeQualityScorer,
  fixCorrectnessScorer,
  reasoningQualityScorer,
} from "./llm-scorers.js";
import {
  costEfficiencyScore,
  iterationEfficiencyScore,
  keywordPresenceScore,
  overallQualityScore,
  successScore,
} from "./scorers.js";
import type { HealingEvalResult, HealingTestCase } from "./types.js";

const isLiveMode = process.env.EVAL_MODE === "live";

// Validate environment for live mode
if (isLiveMode && !process.env.AI_GATEWAY_API_KEY) {
  console.error("Error: AI_GATEWAY_API_KEY is required for live mode.");
  console.error("\nRun with:");
  console.error("  export AI_GATEWAY_API_KEY='your-key-here'");
  console.error("  EVAL_MODE=live bun run eval");
  process.exit(1);
}

/**
 * Mock task that simulates healing results for testing the eval infrastructure.
 * Used in mock mode for fast iteration on eval setup.
 */
const mockTask = (input: HealingTestCase): HealingEvalResult => {
  // Simulate varying results based on the test case
  const baseIterations = input.tags?.includes("lint") ? 2 : 4;
  const baseCost = baseIterations * 0.05;

  // Add some randomness to simulate real behavior
  const jitter = Math.random() * 0.3;

  return {
    success: Math.random() > 0.2, // 80% success rate in mock
    iterations: Math.round(baseIterations + jitter * 3),
    toolCalls: Math.round(baseIterations * 2 + jitter * 5),
    costUSD: baseCost + jitter * 0.1,
    duration: 5000 + Math.random() * 10_000,
    finalMessage: `Fixed the issue in ${input.id}. Applied ${
      input.expected.expectedKeywords?.join(", ") ?? "standard fix"
    }.`,
  };
};

/**
 * Live task that runs the actual HealLoop.
 * Uses real API calls to Claude for authentic evaluation.
 */
const liveTask = async (input: HealingTestCase): Promise<HealingEvalResult> => {
  // Create an isolated context for each test case
  const ctx = createToolContext(
    process.cwd(),
    process.cwd(),
    `eval-${input.id}-${Date.now()}`
  );

  const registry = createToolRegistry(ctx);
  for (const tool of getAllTools()) {
    registry.register(tool);
  }

  const client = new Client();
  const loop = new HealLoop(client, registry, {
    verbose: true,
    budgetPerRunUSD: input.expected.maxCostUSD ?? 1.0,
  });

  const result = await loop.run(SYSTEM_PROMPT, input.errorPrompt);

  return {
    success: result.success,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    costUSD: result.costUSD,
    duration: result.duration,
    finalMessage: result.finalMessage,
  };
};

const task = isLiveMode ? liveTask : mockTask;

/**
 * Heuristic scorer functions for Braintrust.
 * These are fast and free - run on every eval.
 */
const successScorer = ({
  output,
  expected,
}: {
  output: HealingEvalResult;
  expected: HealingTestCase["expected"];
}) => ({
  name: "success",
  score: successScore({ output, expected }),
});

const iterationEfficiencyScorer = ({
  output,
  expected,
}: {
  output: HealingEvalResult;
  expected: HealingTestCase["expected"];
}) => ({
  name: "iteration_efficiency",
  score: iterationEfficiencyScore({ output, expected }),
});

const costEfficiencyScorer = ({
  output,
  expected,
}: {
  output: HealingEvalResult;
  expected: HealingTestCase["expected"];
}) => ({
  name: "cost_efficiency",
  score: costEfficiencyScore({ output, expected }),
});

const keywordPresenceScorer = ({
  output,
  expected,
}: {
  output: HealingEvalResult;
  expected: HealingTestCase["expected"];
}) => ({
  name: "keyword_presence",
  score: keywordPresenceScore({ output, expected }),
});

const overallQualityScorer = ({
  output,
  expected,
}: {
  output: HealingEvalResult;
  expected: HealingTestCase["expected"];
}) => ({
  name: "overall_quality",
  score: overallQualityScore({ output, expected }),
});

/**
 * Combined LLM scorer that runs all three judges in parallel.
 *
 * Performance optimizations:
 * 1. Parallel execution: All LLM calls run concurrently via Promise.all
 * 2. Early skip: Code/reasoning quality scorers are skipped for failed cases
 *    (not meaningful and saves ~66% of LLM costs on failures)
 * 3. Error isolation: Each scorer has independent error handling
 *
 * Returns an array of score objects for Braintrust to unpack.
 */
const combinedLlmScorer = async ({
  input,
  output,
  expected,
}: {
  input: HealingTestCase;
  output: HealingEvalResult;
  expected: HealingTestCase["expected"];
}) => {
  // Helper to safely call an LLM scorer (handles both sync and async returns)
  const safeScore = async (
    name: string,
    scorerFn: () =>
      | { score?: number | null; metadata?: Record<string, unknown> }
      | Promise<{ score?: number | null; metadata?: Record<string, unknown> }>
  ) => {
    try {
      const result = await scorerFn();
      return { name, score: result.score ?? 0, metadata: result.metadata };
    } catch (error) {
      return {
        name,
        score: null,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  };

  // Always run fix correctness - it's the primary metric
  const fixCorrectnessPromise = safeScore("fix_correctness_llm", () =>
    fixCorrectnessScorer({
      input: input.errorPrompt,
      output: output.finalMessage,
      expected: String(expected.shouldSucceed),
    })
  );

  // Skip expensive quality scorers for failed cases - saves LLM costs
  if (!output.success) {
    const fixResult = await fixCorrectnessPromise;
    return [
      fixResult,
      {
        name: "code_quality_llm",
        score: null,
        metadata: { skipped: "fix_failed" },
      },
      {
        name: "reasoning_quality_llm",
        score: null,
        metadata: { skipped: "fix_failed" },
      },
    ];
  }

  // Run all three scorers in parallel for successful cases
  const [fixResult, codeResult, reasoningResult] = await Promise.all([
    fixCorrectnessPromise,
    safeScore("code_quality_llm", () =>
      codeQualityScorer({
        input: input.errorPrompt,
        output: output.finalMessage,
      })
    ),
    safeScore("reasoning_quality_llm", () =>
      reasoningQualityScorer({
        input: input.errorPrompt,
        output: output.finalMessage,
      })
    ),
  ]);

  return [fixResult, codeResult, reasoningResult];
};

/**
 * Main evaluation entry point.
 *
 * Performance settings:
 * - maxConcurrency: 10 limits parallel test cases to avoid rate limits
 * - Combined LLM scorer runs all 3 judges in parallel per test case
 * - CoT disabled in llm-scorers.ts for ~50% token reduction
 */
Eval("Detent", {
  experimentName: `healing-eval-${new Date().toISOString().split("T")[0]}`,

  data: () =>
    HEALING_DATASET.map((tc) => ({
      input: tc,
      expected: tc.expected,
      metadata: {
        id: tc.id,
        tags: tc.tags,
        description: tc.description,
      },
    })),

  task: async (input) => {
    const result = await task(input);
    return result;
  },

  // Limit concurrency to avoid rate limits on LLM APIs
  maxConcurrency: 10,

  scores: [
    // Heuristic scorers (fast, free)
    successScorer,
    iterationEfficiencyScorer,
    costEfficiencyScorer,
    keywordPresenceScorer,
    overallQualityScorer,
    // Combined LLM scorer - runs all judges in parallel, skips on failure
    combinedLlmScorer,
  ],
});
