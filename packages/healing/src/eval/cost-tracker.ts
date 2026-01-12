/**
 * Simple cost tracking utility for eval runs.
 *
 * Tracks costs from HealLoop runs (task costs) and LLM judge calls
 * (scorer costs) to provide visibility into eval expenses.
 *
 * SECURITY: Includes budget limits to prevent runaway costs during eval runs.
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

interface EvalCostSummary {
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

let evalCostTracker: EvalCostSummary = {
  taskCostsUSD: 0,
  judgeCallCostsUSD: 0,
  totalCostUSD: 0,
  testCaseCount: 0,
  judgeCallCount: 0,
  avgCostPerCaseUSD: 0,
  maxBudgetUSD: getMaxEvalBudget(),
};

/**
 * Check if adding a cost would exceed the budget.
 * Throws EvalBudgetExceededError if budget would be exceeded.
 */
const checkBudget = (additionalCost: number): void => {
  const projectedCost = evalCostTracker.totalCostUSD + additionalCost;
  if (projectedCost > evalCostTracker.maxBudgetUSD) {
    throw new EvalBudgetExceededError(
      projectedCost,
      evalCostTracker.maxBudgetUSD
    );
  }
};

/**
 * Track cost from a HealLoop task run.
 * Throws EvalBudgetExceededError if adding this cost would exceed the budget.
 */
export const trackTaskCost = (costUSD: number): void => {
  checkBudget(costUSD);
  evalCostTracker.taskCostsUSD += costUSD;
  evalCostTracker.totalCostUSD += costUSD;
  evalCostTracker.testCaseCount++;
  evalCostTracker.avgCostPerCaseUSD =
    evalCostTracker.totalCostUSD / evalCostTracker.testCaseCount;
};

/**
 * Track cost from an LLM judge/scorer call.
 * Estimated cost per Haiku call: ~$0.003 (average)
 * Throws EvalBudgetExceededError if adding this cost would exceed the budget.
 */
export const trackJudgeCost = (estimatedCostUSD = 0.003): void => {
  checkBudget(estimatedCostUSD);
  evalCostTracker.judgeCallCostsUSD += estimatedCostUSD;
  evalCostTracker.totalCostUSD += estimatedCostUSD;
  evalCostTracker.judgeCallCount++;
  if (evalCostTracker.testCaseCount > 0) {
    evalCostTracker.avgCostPerCaseUSD =
      evalCostTracker.totalCostUSD / evalCostTracker.testCaseCount;
  }
};

/**
 * Get the current cost summary.
 */
export const getEvalCostSummary = (): EvalCostSummary => ({
  ...evalCostTracker,
});

/**
 * Reset the cost tracker (call at start of new eval run).
 */
export const resetEvalCostTracker = (): void => {
  evalCostTracker = {
    taskCostsUSD: 0,
    judgeCallCostsUSD: 0,
    totalCostUSD: 0,
    testCaseCount: 0,
    judgeCallCount: 0,
    avgCostPerCaseUSD: 0,
    maxBudgetUSD: getMaxEvalBudget(),
  };
};

/**
 * Print a cost summary to console.
 */
export const printCostSummary = (): void => {
  const summary = getEvalCostSummary();
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
};
