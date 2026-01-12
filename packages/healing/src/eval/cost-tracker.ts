/**
 * Simple cost tracking utility for eval runs.
 *
 * Tracks costs from HealLoop runs (task costs) and LLM judge calls
 * (scorer costs) to provide visibility into eval expenses.
 *
 * SECURITY: Includes budget limits to prevent runaway costs during eval runs.
 *
 * Uses a factory pattern to avoid shared module state, enabling safe
 * concurrent eval runs within the same process.
 */

/**
 * Default maximum cost for an entire eval run.
 * Can be overridden via EVAL_MAX_BUDGET_USD environment variable.
 */
const DEFAULT_MAX_EVAL_BUDGET_USD = 50;

/**
 * Custom error class for budget exceeded conditions.
 */
export class EvalBudgetExceededError extends Error {
  readonly currentCost: number;
  readonly budget: number;

  constructor(currentCost: number, budget: number) {
    super(
      `Eval budget exceeded: $${currentCost.toFixed(2)} > $${budget.toFixed(2)}`
    );
    this.name = "EvalBudgetExceededError";
    this.currentCost = currentCost;
    this.budget = budget;
  }
}

export interface EvalCostSummary {
  /** Cost of running HealLoop tasks (in live mode) */
  taskCostsUSD: number;
  /** Cost of LLM judge/scorer calls */
  judgeCallCostsUSD: number;
  /** Total cost */
  totalCostUSD: number;
  /** Number of test cases run */
  testCaseCount: number;
  /** Number of judge calls made */
  judgeCallCount: number;
  /** Average cost per test case */
  avgCostPerCaseUSD: number;
  /** Maximum budget for this eval run */
  maxBudgetUSD: number;
}

/**
 * Get the maximum eval budget from environment or use default.
 */
const getMaxEvalBudget = (): number => {
  const envBudget = process.env.EVAL_MAX_BUDGET_USD;
  if (envBudget) {
    const parsed = Number.parseFloat(envBudget);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_EVAL_BUDGET_USD;
};

/**
 * Cost tracker instance with isolated state.
 * Create via createCostTracker() for concurrent-safe tracking.
 */
export interface CostTracker {
  /** Track cost from a HealLoop task run */
  trackTaskCost: (costUSD: number) => void;
  /**
   * Track cost from LLM judge/scorer call(s).
   *
   * @param count - Number of judge calls to track (default: 1)
   * @param costPerCallUSD - Cost per call if available from LLM response metadata,
   *   otherwise uses default estimate. When autoevals provides cost/token
   *   metadata in the future, pass the actual cost here.
   *
   * Default estimate based on typical Claude Haiku pricing:
   * ~2000 input tokens ($0.0016) + ~500 output tokens ($0.002) ≈ $0.004/call
   */
  trackJudgeCost: (count?: number, costPerCallUSD?: number) => void;
  /** Get the current cost summary */
  getSummary: () => EvalCostSummary;
  /** Reset the tracker */
  reset: () => void;
  /** Print a cost summary to console */
  printSummary: () => void;
}

/**
 * Create a new cost tracker instance.
 * Each instance has isolated state, safe for concurrent use.
 */
export const createCostTracker = (
  maxBudgetUSD: number = getMaxEvalBudget()
): CostTracker => {
  let state: EvalCostSummary = {
    taskCostsUSD: 0,
    judgeCallCostsUSD: 0,
    totalCostUSD: 0,
    testCaseCount: 0,
    judgeCallCount: 0,
    avgCostPerCaseUSD: 0,
    maxBudgetUSD,
  };

  const checkBudget = (additionalCost: number): void => {
    const projectedCost = state.totalCostUSD + additionalCost;
    if (projectedCost > state.maxBudgetUSD) {
      throw new EvalBudgetExceededError(projectedCost, state.maxBudgetUSD);
    }
  };

  return {
    trackTaskCost: (costUSD: number): void => {
      checkBudget(costUSD);
      state.taskCostsUSD += costUSD;
      state.totalCostUSD += costUSD;
      state.testCaseCount++;
      state.avgCostPerCaseUSD =
        state.testCaseCount > 0 ? state.totalCostUSD / state.testCaseCount : 0;
    },

    trackJudgeCost: (count = 1, costPerCallUSD = 0.004): void => {
      const totalCost = count * costPerCallUSD;
      checkBudget(totalCost);
      state.judgeCallCostsUSD += totalCost;
      state.totalCostUSD += totalCost;
      state.judgeCallCount += count;
      if (state.testCaseCount > 0) {
        state.avgCostPerCaseUSD = state.totalCostUSD / state.testCaseCount;
      }
    },

    getSummary: (): EvalCostSummary => ({ ...state }),

    reset: (): void => {
      state = {
        taskCostsUSD: 0,
        judgeCallCostsUSD: 0,
        totalCostUSD: 0,
        testCaseCount: 0,
        judgeCallCount: 0,
        avgCostPerCaseUSD: 0,
        maxBudgetUSD,
      };
    },

    printSummary: (): void => {
      const summary = { ...state };
      const budgetUsedPercent = (
        (summary.totalCostUSD / summary.maxBudgetUSD) *
        100
      ).toFixed(1);
      console.log("\n=== Eval Cost Summary ===");
      console.log(`Test cases run: ${summary.testCaseCount}`);
      console.log(`Judge calls made: ${summary.judgeCallCount}`);
      console.log(`Task costs: $${summary.taskCostsUSD.toFixed(4)}`);
      console.log(`Judge costs: $${summary.judgeCallCostsUSD.toFixed(4)}`);
      console.log(`Total cost: $${summary.totalCostUSD.toFixed(4)}`);
      console.log(
        `Budget: $${summary.totalCostUSD.toFixed(2)} / $${summary.maxBudgetUSD.toFixed(2)} (${budgetUsedPercent}%)`
      );
      console.log(`Avg per case: $${summary.avgCostPerCaseUSD.toFixed(4)}`);
      console.log("========================\n");
    },
  };
};

/**
 * Default global tracker for backwards compatibility.
 * For concurrent scenarios, prefer createCostTracker() to get isolated instances.
 */
const defaultTracker = createCostTracker();

/** @deprecated Use createCostTracker() for concurrent-safe tracking */
export const trackTaskCost = defaultTracker.trackTaskCost;

/** @deprecated Use createCostTracker() for concurrent-safe tracking */
export const trackJudgeCost = defaultTracker.trackJudgeCost;

/** @deprecated Use createCostTracker() for concurrent-safe tracking */
export const getEvalCostSummary = defaultTracker.getSummary;

/** @deprecated Use createCostTracker() for concurrent-safe tracking */
export const resetEvalCostTracker = defaultTracker.reset;

/** @deprecated Use createCostTracker() for concurrent-safe tracking */
export const printCostSummary = defaultTracker.printSummary;
