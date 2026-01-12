// biome-ignore-all lint/performance/noBarrelFile: This is the eval module's public API

// Cost tracking
export {
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
  HEALING_DATASET,
} from "./dataset.js";

// LLM-as-Judge scorers
export {
  codeQualityScorer,
  fixCorrectnessScorer,
  reasoningQualityScorer,
} from "./llm-scorers.js";

// Heuristic scorers
export {
  costEfficiencyScore,
  iterationEfficiencyScore,
  keywordPresenceScore,
  overallQualityScore,
  successScore,
} from "./scorers.js";

// Tracing
export {
  initTracing,
  isTracingEnabled,
  logEvent,
  tracedRun,
} from "./tracing.js";

// Types
export type { HealingEvalResult, HealingTestCase } from "./types.js";
