import { isBlacklistedWorkflow } from "./workflow-blacklist";

export interface WorkflowRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  runAttempt: number;
  runStartedAt: Date | null;
  event: string;
}

export interface WorkflowRunEvaluation {
  allCompleted: boolean;
  ciRelevantRuns: WorkflowRunSummary[];
  skippedRuns: WorkflowRunSummary[];
  pendingCiRuns: WorkflowRunSummary[];
  stuckRuns: WorkflowRunSummary[];
  blacklistedRuns: WorkflowRunSummary[];
  nonBlacklistedRuns: WorkflowRunSummary[];
}

const CI_RELEVANT_EVENTS = new Set<string>([
  "pull_request",
  "pull_request_target",
  "push",
  "merge_group",
]);

const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

const evaluateWorkflowRuns = (
  runs: WorkflowRunSummary[],
  nowMs: number
): WorkflowRunEvaluation => {
  const blacklistedRuns: WorkflowRunSummary[] = [];
  const nonBlacklistedRuns: WorkflowRunSummary[] = [];

  for (const run of runs) {
    if (isBlacklistedWorkflow(run.name)) {
      blacklistedRuns.push(run);
    } else {
      nonBlacklistedRuns.push(run);
    }
  }

  const ciRelevantRuns = nonBlacklistedRuns.filter((run) =>
    CI_RELEVANT_EVENTS.has(run.event)
  );

  const skippedRuns = nonBlacklistedRuns.filter(
    (run) => !CI_RELEVANT_EVENTS.has(run.event)
  );

  const allCompleted =
    ciRelevantRuns.length === 0 ||
    ciRelevantRuns.every((run) => run.status === "completed");

  const pendingCiRuns = ciRelevantRuns.filter(
    (run) => run.status !== "completed"
  );

  const stuckRuns = pendingCiRuns.filter(
    (run) =>
      run.runStartedAt &&
      nowMs - run.runStartedAt.getTime() > STUCK_THRESHOLD_MS
  );

  return {
    allCompleted,
    ciRelevantRuns,
    skippedRuns,
    pendingCiRuns,
    stuckRuns,
    blacklistedRuns,
    nonBlacklistedRuns,
  };
};

export { evaluateWorkflowRuns };
