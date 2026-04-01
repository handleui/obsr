// Job-level evaluation for workflow runs
// Similar to workflow-runs.ts but for individual jobs within a workflow
// See: https://docs.github.com/en/rest/actions/workflow-jobs

export interface StepSummary {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface JobSummary {
  id: number;
  runId: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  // Additional fields for better tracking and display
  htmlUrl: string | null;
  workflowName: string | null;
  headBranch: string | null;
  runnerName: string | null;
  // Step-level details (optional, may not be present in all responses)
  steps?: StepSummary[];
}

export interface JobEvaluation {
  allCompleted: boolean;
  jobs: JobSummary[];
  pendingJobs: JobSummary[];
  failedJobs: JobSummary[];
  successJobs: JobSummary[];
  skippedJobs: JobSummary[];
  cancelledJobs: JobSummary[];
  stuckJobs: JobSummary[];
}

// Jobs running longer than 30 minutes may be stuck (same threshold as workflow-runs.ts)
const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

const evaluateJobs = (jobs: JobSummary[], nowMs?: number): JobEvaluation => {
  const currentTime = nowMs ?? Date.now();

  const pendingJobs = jobs.filter((job) => job.status !== "completed");
  const completedJobs = jobs.filter((job) => job.status === "completed");

  const failedJobs = completedJobs.filter(
    (job) => job.conclusion === "failure" || job.conclusion === "timed_out"
  );
  const successJobs = completedJobs.filter(
    (job) => job.conclusion === "success"
  );
  const skippedJobs = completedJobs.filter(
    (job) => job.conclusion === "skipped"
  );
  const cancelledJobs = completedJobs.filter(
    (job) => job.conclusion === "cancelled"
  );

  // Detect stuck jobs: running for longer than threshold
  const stuckJobs = pendingJobs.filter(
    (job) =>
      job.status === "in_progress" &&
      job.startedAt &&
      currentTime - job.startedAt.getTime() > STUCK_THRESHOLD_MS
  );

  const allCompleted = pendingJobs.length === 0;

  return {
    allCompleted,
    jobs,
    pendingJobs,
    failedJobs,
    successJobs,
    skippedJobs,
    cancelledJobs,
    stuckJobs,
  };
};

export { evaluateJobs };
