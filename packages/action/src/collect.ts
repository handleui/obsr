// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as github from "@actions/github";

const REF_PREFIX_REGEX = /^refs\/(heads|tags)\//;

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
    codeSnippet?: {
      lines: string[];
      startLine: number;
      /** 1-indexed position of the error line within the snippet (not the actual source line number) */
      errorLine: number;
      language: string;
    };
  }>;
}

/**
 * Safely parse JSON from environment variable, returning fallback on failure.
 */
const safeJsonParse = <T>(json: string | undefined, fallback: T): T => {
  if (!json) {
    return fallback;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

export const collect = (): ReportPayload => {
  const { context } = github;

  const stepsData = safeJsonParse<
    Record<
      string,
      {
        outcome?: string;
        conclusion?: string;
        outputs?: Record<string, string>;
      }
    >
  >(process.env.STEPS_CONTEXT, {});

  const steps: StepOutcome[] = Object.entries(stepsData).map(([id, data]) => ({
    id,
    outcome: (data.outcome ?? "skipped") as StepOutcome["outcome"],
    conclusion: (data.conclusion ?? "skipped") as StepOutcome["conclusion"],
  }));

  const matrix = safeJsonParse<Record<string, string> | undefined>(
    process.env.MATRIX_CONTEXT,
    undefined
  );

  return {
    runId: context.runId,
    repository: `${context.repo.owner}/${context.repo.repo}`,
    commitSha: context.sha,
    headBranch: context.ref.replace(REF_PREFIX_REGEX, ""),
    workflowName: context.workflow,
    workflowJob: context.job,
    runAttempt: Number.parseInt(process.env.GITHUB_RUN_ATTEMPT || "1", 10),
    matrix,
    steps,
    errors: [],
  };
};
