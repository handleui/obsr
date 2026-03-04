/**
 * Braintrust evaluation runner for the resolving loop.
 *
 * Run with: bun run eval
 *
 * Environment variables:
 * - BRAINTRUST_API_KEY: Required for logging to Braintrust
 * - AI_GATEWAY_API_KEY: Required for running actual resolving loops (live mode)
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

import { randomUUID } from "node:crypto";
import { Eval } from "braintrust";
import { ResolveLoop } from "../loop.js";
import { SYSTEM_PROMPT } from "../prompt/system.js";
import {
  createToolContext,
  createToolRegistry,
  getAllTools,
} from "../tools/index.js";
import { createCostTracker } from "./cost-tracker.js";
import { RESOLVING_DATASET } from "./dataset.js";
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
import type { ResolvingEvalResult, ResolvingTestCase } from "./types.js";

const isLiveMode = process.env.EVAL_MODE === "live";

// Create a cost tracker for this eval run
const evalCostTracker = createCostTracker();

// Print cost summary when eval completes
process.on("beforeExit", () => {
  evalCostTracker.printSummary();
});

// Validate environment for live mode
if (isLiveMode && !process.env.AI_GATEWAY_API_KEY) {
  console.error("Error: AI_GATEWAY_API_KEY is required for live mode.");
  console.error("\nRun with:");
  console.error("  export AI_GATEWAY_API_KEY='your-key-here'");
  console.error("  EVAL_MODE=live bun run eval");
  process.exit(1);
}

/**
 * Mock task that simulates resolving results for testing the eval infrastructure.
 * Used in mock mode for fast iteration on eval setup.
 */
const mockTask = (input: ResolvingTestCase): ResolvingEvalResult => {
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
 * Live task that runs the actual ResolveLoop.
 * Uses real API calls to the configured model for authentic evaluation.
 */
const liveTask = async (
  input: ResolvingTestCase
): Promise<ResolvingEvalResult> => {
  const startTime = Date.now();

  try {
    // Create an isolated context for each test case with a robust unique ID
    const ctx = createToolContext(
      process.cwd(),
      process.cwd(),
      `eval-${input.id}-${randomUUID()}`
    );

    const registry = createToolRegistry(ctx);
    for (const tool of getAllTools()) {
      registry.register(tool);
    }

    const loop = new ResolveLoop(registry, {
      verbose: true,
      budgetPerRunUSD: input.expected.maxCostUSD ?? 1.0,
    });

    const result = await loop.run(SYSTEM_PROMPT, input.errorPrompt);

    // Track task cost for eval summary
    evalCostTracker.trackTaskCost(result.costUSD);

    return {
      success: result.success,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      costUSD: result.costUSD,
      duration: result.duration,
      finalMessage: result.finalMessage,
    };
  } catch (error) {
    // Return a failed result with error details for eval tracking
    return {
      success: false,
      iterations: 0,
      toolCalls: 0,
      costUSD: 0,
      duration: Date.now() - startTime,
      finalMessage: `Error during resolving: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
  output: ResolvingEvalResult;
  expected: ResolvingTestCase["expected"];
}) => ({
  name: "success",
  score: successScore({ output, expected }),
});

const iterationEfficiencyScorer = ({
  output,
  expected,
}: {
  output: ResolvingEvalResult;
  expected: ResolvingTestCase["expected"];
}) => ({
  name: "iteration_efficiency",
  score: iterationEfficiencyScore({ output, expected }),
});

const costEfficiencyScorer = ({
  output,
  expected,
}: {
  output: ResolvingEvalResult;
  expected: ResolvingTestCase["expected"];
}) => ({
  name: "cost_efficiency",
  score: costEfficiencyScore({ output, expected }),
});

const keywordPresenceScorer = ({
  output,
  expected,
}: {
  output: ResolvingEvalResult;
  expected: ResolvingTestCase["expected"];
}) => ({
  name: "keyword_presence",
  score: keywordPresenceScore({ output, expected }),
});

const overallQualityScorer = ({
  output,
  expected,
}: {
  output: ResolvingEvalResult;
  expected: ResolvingTestCase["expected"];
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
  input: ResolvingTestCase;
  output: ResolvingEvalResult;
  expected: ResolvingTestCase["expected"];
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
      expected: expected.shouldSucceed
        ? "The fix should successfully resolve the error"
        : "This error may not be fully fixable or requires manual intervention",
    })
  );

  // Skip expensive quality scorers for failed cases - saves LLM costs
  if (!output.success) {
    const fixResult = await fixCorrectnessPromise;
    // Track 1 judge call for failed cases
    evalCostTracker.trackJudgeCost();
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

  // Track 3 judge calls for successful cases
  evalCostTracker.trackJudgeCost(3);

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
  experimentName: `resolving-eval-${new Date().toISOString().split("T")[0]}`,

  data: () =>
    RESOLVING_DATASET.map((tc) => ({
      input: tc,
      expected: tc.expected,
      metadata: {
        id: tc.id,
        tags: tc.tags,
        description: tc.description,
      },
    })),

  task,

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
