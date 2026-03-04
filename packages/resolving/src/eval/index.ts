// biome-ignore-all lint/performance/noBarrelFile: This is the eval module's public API

/**
 * Eval module exports.
 *
 * This module contains utilities for running evaluations, including:
 * - Cost tracking
 * - Dataset and test cases
 * - Heuristic and LLM-as-Judge scorers
 * - Braintrust tracing
 *
 * NOTE: This module depends on devDependencies (braintrust, autoevals).
 * Import from "@detent/resolving/eval" only in eval/test contexts.
 */

export type { CostTracker, EvalCostSummary } from "./cost-tracker.js";
// Cost tracking
export {
  createCostTracker,
  EvalBudgetExceededError,
  getEvalCostSummary,
  printCostSummary,
  resetEvalCostTracker,
  trackJudgeCost,
  trackTaskCost,
} from "./cost-tracker.js";

// Dataset
export {
  getTestCaseById,
  getTestCasesByTag,
  RESOLVING_DATASET,
} from "./dataset.js";

// LLM-as-Judge scorers (require autoevals devDependency)
export {
  codeQualityScorer,
  fixCorrectnessScorer,
  reasoningQualityScorer,
} from "./llm-scorers.js";

// Heuristic scorers (no external dependencies)
export {
  costEfficiencyScore,
  iterationEfficiencyScore,
  keywordPresenceScore,
  overallQualityScore,
  successScore,
} from "./scorers.js";

// Tracing (requires braintrust devDependency)
export {
  initTracing,
  isTracingEnabled,
  logEvent,
  tracedRun,
} from "./tracing.js";

// Types
export type { ResolvingEvalResult, ResolvingTestCase } from "./types.js";
