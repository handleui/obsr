import { hasRateLimitHeadroom } from "../../../services/github/rate-limit";
import type { JobEvaluation } from "../../../services/github/workflow-jobs";
import type { WorkflowRunEvaluation } from "../../../services/github/workflow-runs";

// Max workflows to fetch jobs for - limits rate limit consumption
// since jobs API is optional/cosmetic (trade-off: fewer details vs quota preservation)
const MAX_WORKFLOWS_FOR_JOB_FETCH = 2;

/**
 * Interface for the GitHub service methods needed by job fetcher.
 * Using a minimal interface instead of the full service type avoids circular dependencies.
 */
interface JobFetcherGitHubService {
  listJobsForWorkflowRun: (
    token: string,
    owner: string,
    repo: string,
    runId: number
  ) => Promise<{ evaluation: JobEvaluation }>;
}

/**
 * Fetches job details for in-progress workflows with rate limit protection.
 *
 * This function:
 * - Limits fetches to MAX_WORKFLOWS_FOR_JOB_FETCH workflows to conserve rate limit
 * - Skips entirely if rate limit is low (preserves quota for critical operations)
 * - Uses sequential fetching to avoid burst of concurrent requests
 *
 * @returns Map of runId to JobEvaluation for successfully fetched jobs
 */
export const fetchJobDetailsWithRateLimit = async (
  github: JobFetcherGitHubService,
  token: string,
  owner: string,
  repo: string,
  evaluation: WorkflowRunEvaluation,
  logContext: string
): Promise<Map<number, JobEvaluation>> => {
  const jobsByRunId = new Map<number, JobEvaluation>();

  // Skip entirely if rate limit is low (preserves quota for critical operations)
  if (!hasRateLimitHeadroom()) {
    console.log(`[${logContext}] Skipping job fetch - rate limit low`);
    return jobsByRunId;
  }

  const inProgressRuns = evaluation.pendingCiRuns.slice(
    0,
    MAX_WORKFLOWS_FOR_JOB_FETCH
  );

  // Sequential fetching to avoid burst of concurrent requests
  // Trade-off: slightly slower but gentler on rate limits and secondary limits
  for (const run of inProgressRuns) {
    try {
      const { evaluation: jobEval } = await github.listJobsForWorkflowRun(
        token,
        owner,
        repo,
        run.id
      );
      jobsByRunId.set(run.id, jobEval);
    } catch (error) {
      // Graceful fallback - will display workflow-level info instead of job details
      console.debug(
        `[${logContext}] Failed to fetch jobs for run ${run.id}:`,
        error
      );
    }
  }

  return jobsByRunId;
};
