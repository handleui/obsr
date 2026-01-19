// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as github from "@actions/github";

export interface StepOutcome {
  id: string;
  name?: string;
  outcome: "success" | "failure" | "cancelled" | "skipped";
  conclusion: "success" | "failure" | "cancelled" | "skipped";
}

export interface ReportPayload {
  runId: number;
  repository: string;
  commitSha: string;
  headBranch: string;
  workflowName: string;
  workflowJob: string;
  runAttempt: number;
  matrix?: Record<string, string>;
  steps: StepOutcome[];
  errors: Array<{
    message: string;
    filePath?: string;
    line?: number;
    column?: number;
    category?: string;
    severity?: "error" | "warning";
    ruleId?: string;
    stackTrace?: string;
    stepId?: string;
    exitCode?: number;
  }>;
}

export const collect = (): ReportPayload => {
  const { context } = github;

  const stepsJson = process.env.STEPS_CONTEXT || "{}";
  const stepsData = JSON.parse(stepsJson) as Record<
    string,
    {
      outcome?: string;
      conclusion?: string;
      outputs?: Record<string, string>;
    }
  >;

  const steps: StepOutcome[] = Object.entries(stepsData).map(([id, data]) => ({
    id,
    outcome: (data.outcome ?? "skipped") as StepOutcome["outcome"],
    conclusion: (data.conclusion ?? "skipped") as StepOutcome["conclusion"],
  }));

  const matrixJson = process.env.MATRIX_CONTEXT;
  const matrix = matrixJson ? JSON.parse(matrixJson) : undefined;

  return {
    runId: context.runId,
    repository: `${context.repo.owner}/${context.repo.repo}`,
    commitSha: context.sha,
    headBranch: context.ref.replace("refs/heads/", ""),
    workflowName: context.workflow,
    workflowJob: context.job,
    runAttempt: Number.parseInt(process.env.GITHUB_RUN_ATTEMPT || "1", 10),
    matrix,
    steps,
    errors: [],
  };
};
