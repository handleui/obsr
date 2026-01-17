// Job-level evaluation for workflow runs
// Similar to workflow-runs.ts but for individual jobs within a workflow

export interface JobSummary {
  id: number;
  runId: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: Date | null;
}

export interface JobEvaluation {
  allCompleted: boolean;
  jobs: JobSummary[];
  pendingJobs: JobSummary[];
  failedJobs: JobSummary[];
}

const evaluateJobs = (jobs: JobSummary[]): JobEvaluation => {
  const pendingJobs = jobs.filter((job) => job.status !== "completed");
  const failedJobs = jobs.filter(
    (job) => job.status === "completed" && job.conclusion === "failure"
  );

  const allCompleted = pendingJobs.length === 0;

  return {
    allCompleted,
    jobs,
    pendingJobs,
    failedJobs,
  };
};

export { evaluateJobs };
