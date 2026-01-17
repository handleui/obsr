import type { Env } from "../../types/env";
import type { LogExtractionResult } from "../log-extractor";
import { blobToArrayBuffer, extractLogsFromZip } from "../log-extractor";
import { generateAppJwt } from "./jwt";
import {
  handleApiError,
  logRateLimitWarning,
  parseRateLimitHeaders,
} from "./rate-limit";
import type {
  CheckRunOutput,
  CheckRunResponse,
  CommentResponse,
  CreateCommitResponse,
  CreateTreeResponse,
  GitHubServiceConfig,
  GitTreeItem,
  InstallationInfo,
  InstallationReposResponse,
  InstallationTokenResponse,
  RefResponse,
  WorkflowJobsResponse,
  WorkflowRunResponse,
  WorkflowRunsResponse,
} from "./types";
import {
  GIT_FULL_SHA_PATTERN,
  GITHUB_API,
  isValidBranchName,
  isValidGitHubName,
  validateCommentId,
  validateGitSha,
  validateIssueNumber,
  validateOwnerRepo,
} from "./validation";
import type { JobEvaluation, JobSummary } from "./workflow-jobs";
import { evaluateJobs } from "./workflow-jobs";
import type {
  WorkflowRunEvaluation,
  WorkflowRunSummary,
} from "./workflow-runs";
import { evaluateWorkflowRuns } from "./workflow-runs";

/**
 * Module-level cache for installation tokens.
 * Survives across function calls within the same Worker isolate.
 * Cache lifecycle: persists until isolate is recycled (cold start clears it).
 * This is intentional - tokens are short-lived (1hr) and isolate recycling
 * provides natural cache invalidation without explicit TTL management.
 */
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/**
 * Module-level singleton for GitHub service instance.
 * Re-uses the same service across all requests within an isolate to share
 * the token cache. Cleared on cold start when new isolate is created.
 */
let cachedService: ReturnType<typeof createGitHubServiceInternal> | null = null;
let cachedAppId: string | null = null;

const createGitHubServiceInternal = (env: Env) => {
  const config: GitHubServiceConfig = {
    appId: env.GITHUB_APP_ID,
    // Handle literal \n from .dev.vars (dotenv doesn't parse multiline values)
    privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };

  const getInstallationToken = async (
    installationId: number
  ): Promise<string> => {
    // Check cache first
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      console.log(
        `[github] Token cache hit for installation ${installationId}`
      );
      return cached.token;
    }

    // Generate app JWT
    const jwt = await generateAppJwt(config);

    // Exchange JWT for installation token
    const response = await fetch(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to get installation token: ${response.status} ${error}`
      );
    }

    const data = (await response.json()) as InstallationTokenResponse;

    // Cache the token
    tokenCache.set(installationId, {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    });

    console.log(
      `[github] Got installation token for ${installationId} (expires: ${data.expires_at})`
    );

    return data.token;
  };

  const fetchWorkflowLogs = async (
    token: string,
    owner: string,
    repo: string,
    runId: number
  ): Promise<LogExtractionResult> => {
    const context = `fetchWorkflowLogs(${owner}/${repo}, runId=${runId})`;

    // Validate inputs to prevent URL manipulation
    validateOwnerRepo(owner, repo, context);

    // GitHub returns a redirect to a zip file containing logs
    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/logs`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
        redirect: "follow",
      }
    );

    const rateLimitInfo = parseRateLimitHeaders(response);
    logRateLimitWarning(rateLimitInfo, context);

    if (!response.ok) {
      await handleApiError(response, rateLimitInfo, context, {
        404: "Workflow run not found or logs expired",
      });
    }

    // Extract logs from zip archive
    const blob = await response.blob();
    const arrayBuffer = await blobToArrayBuffer(blob);
    const result = extractLogsFromZip(arrayBuffer);

    console.log(
      `[github] ${context}: Fetched ${result.totalBytes} bytes, ${result.jobCount} jobs`
    );

    return result;
  };

  const postComment = async (
    token: string,
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> => {
    // Validate inputs to prevent URL manipulation
    if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
      throw new Error("Invalid owner or repo name");
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to post comment: ${response.status} ${error}`);
    }

    console.log(`[github] Posted comment to ${owner}/${repo}#${issueNumber}`);
  };

  const pushCommit = async (
    token: string,
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: Array<{ path: string; content: string }>
  ): Promise<string> => {
    // Validate inputs to prevent URL manipulation
    if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
      throw new Error("Invalid owner or repo name");
    }
    if (!isValidBranchName(branch)) {
      throw new Error("Invalid branch name");
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Detent-App",
      "Content-Type": "application/json",
    };

    // 1. Get current commit SHA for the branch
    const refResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      { headers }
    );

    if (!refResponse.ok) {
      throw new Error(`Failed to get branch ref: ${refResponse.status}`);
    }

    const refData = (await refResponse.json()) as RefResponse;
    const baseSha = refData.object.sha;

    // 2. Build tree items with content (GitHub creates blobs automatically)
    const treeItems: GitTreeItem[] = files.map((file) => ({
      path: file.path,
      mode: "100644" as const,
      type: "blob" as const,
      content: file.content,
    }));

    // 3. Create tree (GitHub will create blobs from content)
    const treeResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          base_tree: baseSha,
          tree: treeItems,
        }),
      }
    );

    if (!treeResponse.ok) {
      throw new Error(`Failed to create tree: ${treeResponse.status}`);
    }

    const treeData = (await treeResponse.json()) as CreateTreeResponse;

    // 4. Create commit
    const commitResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          message,
          tree: treeData.sha,
          parents: [baseSha],
        }),
      }
    );

    if (!commitResponse.ok) {
      throw new Error(`Failed to create commit: ${commitResponse.status}`);
    }

    const commitData = (await commitResponse.json()) as CreateCommitResponse;

    // 5. Update branch ref
    const updateRefResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          sha: commitData.sha,
        }),
      }
    );

    if (!updateRefResponse.ok) {
      throw new Error(`Failed to update ref: ${updateRefResponse.status}`);
    }

    console.log(
      `[github] Pushed commit ${commitData.sha.slice(0, 7)} to ${owner}/${repo}:${branch}`
    );

    return commitData.sha;
  };

  const getPullRequestForRun = async (
    token: string,
    owner: string,
    repo: string,
    runId: number
  ): Promise<number | null> => {
    // Validate inputs to prevent URL manipulation
    if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
      throw new Error("Invalid owner or repo name");
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get workflow run: ${response.status}`);
    }

    const data = (await response.json()) as WorkflowRunResponse;

    const firstPR = data.pull_requests[0];
    return firstPR?.number ?? null;
  };

  /**
   * Find PR number for a commit SHA using the commits API.
   * This works for fork PRs where workflow_run.pull_requests is empty.
   * Returns the first open PR associated with the commit, or null if none found.
   */
  const getPullRequestForCommit = async (
    token: string,
    owner: string,
    repo: string,
    sha: string
  ): Promise<number | null> => {
    // Validate inputs to prevent URL manipulation
    if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
      throw new Error("Invalid owner or repo name");
    }

    if (!GIT_FULL_SHA_PATTERN.test(sha)) {
      throw new Error("Invalid SHA format");
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}/pulls`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );

    if (!response.ok) {
      // 409 means empty repo or commit not found - not an error, just no PR
      if (response.status === 409) {
        return null;
      }
      throw new Error(`Failed to get PRs for commit: ${response.status}`);
    }

    const prs = (await response.json()) as Array<{
      number: number;
      state: string;
    }>;

    // Prefer open PRs, but fall back to any PR
    const openPr = prs.find((pr) => pr.state === "open");
    return openPr?.number ?? prs[0]?.number ?? null;
  };

  const getInstallationInfo = async (
    installationId: number
  ): Promise<InstallationInfo | null> => {
    // Generate app JWT to call app-level endpoints
    const jwt = await generateAppJwt(config);

    const response = await fetch(
      `${GITHUB_API}/app/installations/${installationId}`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );

    if (response.status === 404) {
      // Installation not found (uninstalled)
      return null;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to get installation info: ${response.status} ${error}`
      );
    }

    return (await response.json()) as InstallationInfo;
  };

  const getInstallationRepos = async (
    installationId: number
  ): Promise<InstallationReposResponse["repositories"]> => {
    const token = await getInstallationToken(installationId);
    const allRepos: InstallationReposResponse["repositories"] = [];
    let page = 1;
    const perPage = 100;

    // Paginate through all repos
    while (true) {
      const response = await fetch(
        `${GITHUB_API}/installation/repositories?per_page=${perPage}&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Detent-App",
          },
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(
          `Failed to get installation repos: ${response.status} ${error}`
        );
      }

      const data = (await response.json()) as InstallationReposResponse;
      allRepos.push(...data.repositories);

      // Check if we've fetched all repos
      if (allRepos.length >= data.total_count) {
        break;
      }
      page++;
    }

    return allRepos;
  };

  // GET /repos/{owner}/{repo}/actions/runs?head_sha={sha}
  // Returns all workflow runs for a commit with full evaluation details
  // Includes metadata for run tracking (branch, attempt, timing, event)
  const listWorkflowRunsForCommit = async (
    token: string,
    owner: string,
    repo: string,
    headSha: string
  ): Promise<{
    allCompleted: boolean;
    runs: WorkflowRunSummary[];
    evaluation: WorkflowRunEvaluation;
  }> => {
    const context = `listWorkflowRunsForCommit(${owner}/${repo}@${headSha.slice(0, 7)})`;

    // Validate inputs
    validateOwnerRepo(owner, repo, context);
    validateGitSha(headSha, context);

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/runs?head_sha=${headSha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );

    const rateLimitInfo = parseRateLimitHeaders(response);
    logRateLimitWarning(rateLimitInfo, context);

    if (!response.ok) {
      await handleApiError(response, rateLimitInfo, context, {});
    }

    const data = (await response.json()) as WorkflowRunsResponse;

    // Handle empty or missing workflow_runs array
    const workflowRuns = data.workflow_runs ?? [];
    const runs: WorkflowRunSummary[] = workflowRuns.map((run) => ({
      id: run.id,
      name: run.name ?? "Unknown",
      status: run.status ?? "unknown",
      conclusion: run.conclusion,
      headBranch: run.head_branch ?? "unknown",
      runAttempt: run.run_attempt ?? 1,
      runStartedAt: run.run_started_at ? new Date(run.run_started_at) : null,
      event: run.event ?? "unknown",
    }));

    const now = Date.now();
    const {
      allCompleted,
      blacklistedRuns,
      ciRelevantRuns,
      nonBlacklistedRuns,
      pendingCiRuns,
      skippedRuns,
      stuckRuns,
    } = evaluateWorkflowRuns(runs, now);

    // Log with status/conclusion for debugging stuck workflows
    console.log(
      `[github] ${context}: Found ${runs.length} workflow runs (${blacklistedRuns.length} blacklisted, ${ciRelevantRuns.length} CI-relevant, ${skippedRuns.length} skipped), allCompleted=${allCompleted}${
        blacklistedRuns.length > 0
          ? `, blacklisted: ${blacklistedRuns.map((r) => r.name).join(", ")}`
          : ""
      }${
        pendingCiRuns.length > 0
          ? `, pending: ${pendingCiRuns.map((r) => `${r.name}[${r.status}](${r.event})`).join(", ")}`
          : ""
      }${
        skippedRuns.length > 0
          ? `, skipped events: ${skippedRuns.map((r) => `${r.name}[${r.status}/${r.conclusion}](${r.event})`).join(", ")}`
          : ""
      }`
    );

    // Warn about potentially stuck workflows
    if (stuckRuns.length > 0) {
      console.warn(
        `[github] ${context}: WARNING - ${stuckRuns.length} workflow(s) may be stuck (running > 30min): ${stuckRuns
          .map((r) => {
            const ageMin = r.runStartedAt
              ? Math.round((now - r.runStartedAt.getTime()) / 60_000)
              : "?";
            return `${r.name}[${r.status}, ${ageMin}min](${r.event})`;
          })
          .join(", ")}`
      );
    }

    const evaluation: WorkflowRunEvaluation = {
      allCompleted,
      ciRelevantRuns,
      skippedRuns,
      pendingCiRuns,
      stuckRuns,
      blacklistedRuns,
      nonBlacklistedRuns,
    };

    return { allCompleted, runs: nonBlacklistedRuns, evaluation };
  };

  // GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs
  // Returns all jobs for a workflow run with evaluation details
  const listJobsForWorkflowRun = async (
    token: string,
    owner: string,
    repo: string,
    runId: number
  ): Promise<{
    jobs: JobSummary[];
    evaluation: JobEvaluation;
  }> => {
    const context = `listJobsForWorkflowRun(${owner}/${repo}, runId=${runId})`;

    // Validate inputs
    validateOwnerRepo(owner, repo, context);
    if (!Number.isInteger(runId) || runId <= 0) {
      throw new Error(`${context}: Invalid run ID`);
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );

    const rateLimitInfo = parseRateLimitHeaders(response);
    logRateLimitWarning(rateLimitInfo, context);

    if (!response.ok) {
      await handleApiError(response, rateLimitInfo, context, {
        404: "Workflow run not found",
      });
    }

    const data = (await response.json()) as WorkflowJobsResponse;

    const jobs: JobSummary[] = (data.jobs ?? []).map((job) => ({
      id: job.id,
      runId: job.run_id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      startedAt: job.started_at ? new Date(job.started_at) : null,
    }));

    const evaluation = evaluateJobs(jobs);

    console.log(
      `[github] ${context}: Found ${jobs.length} jobs (${evaluation.pendingJobs.length} pending, ${evaluation.failedJobs.length} failed)`
    );

    return { jobs, evaluation };
  };

  // POST /repos/{owner}/{repo}/check-runs
  const createCheckRun = async (
    token: string,
    options: {
      owner: string;
      repo: string;
      headSha: string;
      name: string;
      status: "queued" | "in_progress";
      output?: { title: string; summary: string };
    }
  ): Promise<{ id: number; htmlUrl: string }> => {
    const { owner, repo, headSha, name, status, output } = options;
    const context = `createCheckRun(${owner}/${repo}@${headSha.slice(0, 7)}, "${name}")`;

    // Validate inputs
    validateOwnerRepo(owner, repo, context);
    validateGitSha(headSha, context);
    if (!name || name.trim().length === 0) {
      throw new Error(`${context}: Check run name cannot be empty`);
    }
    // GitHub recommends unique check names to appear correctly in UI
    if (name.length > 200) {
      throw new Error(`${context}: Check run name too long (max 200 chars)`);
    }

    const body = {
      name: name.trim(),
      head_sha: headSha,
      status,
      ...(output && { output }),
    };

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/check-runs`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const rateLimitInfo = parseRateLimitHeaders(response);
    logRateLimitWarning(rateLimitInfo, context);

    if (!response.ok) {
      await handleApiError(response, rateLimitInfo, context, {
        404: "Repository not found or app lacks permission to create check runs",
        422: "Validation failed - check that SHA exists and name is valid.",
      });
    }

    const data = (await response.json()) as CheckRunResponse;

    // Validate response has expected fields
    if (typeof data.id !== "number" || !data.html_url) {
      throw new Error(
        `${context}: Unexpected response format - missing id or html_url`
      );
    }

    console.log(
      `[github] ${context}: Created check run ${data.id} at ${data.html_url}`
    );

    return { id: data.id, htmlUrl: data.html_url };
  };

  // PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}
  const updateCheckRun = async (
    token: string,
    options:
      | {
          owner: string;
          repo: string;
          checkRunId: number;
          status: "completed";
          conclusion: "success" | "failure" | "neutral" | "cancelled";
          output?: CheckRunOutput;
        }
      | {
          owner: string;
          repo: string;
          checkRunId: number;
          status: "in_progress";
          output?: CheckRunOutput;
        }
  ): Promise<void> => {
    const { owner, repo, checkRunId, status, output } = options;
    const context = `updateCheckRun(${owner}/${repo}, checkRunId=${checkRunId})`;

    // Validate inputs
    validateOwnerRepo(owner, repo, context);
    if (!Number.isInteger(checkRunId) || checkRunId <= 0) {
      throw new Error(`${context}: Invalid check run ID`);
    }

    const body: Record<string, unknown> = {
      status,
      ...(output && { output }),
    };

    // Only add conclusion and completed_at for completed status
    if (status === "completed") {
      body.conclusion = (
        options as {
          conclusion: "success" | "failure" | "neutral" | "cancelled";
        }
      ).conclusion;
      body.completed_at = new Date().toISOString();
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/check-runs/${checkRunId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const rateLimitInfo = parseRateLimitHeaders(response);
    logRateLimitWarning(rateLimitInfo, context);

    if (!response.ok) {
      await handleApiError(response, rateLimitInfo, context, {
        404: "Check run not found or app lacks permission to update it",
        422: "Validation failed - check run may already be completed or conclusion invalid.",
      });
    }

    const logStatus =
      status === "completed"
        ? (options as { conclusion: string }).conclusion
        : status;
    console.log(`[github] ${context}: Updated to ${logStatus}`);
  };

  // POST /repos/{owner}/{repo}/issues/{issue_number}/comments - returns comment ID
  const postCommentWithId = async (
    token: string,
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ id: number; htmlUrl: string }> => {
    const context = `postCommentWithId(${owner}/${repo}#${issueNumber})`;

    // Validate inputs
    validateOwnerRepo(owner, repo, context);
    validateIssueNumber(issueNumber, context);
    if (!body || body.trim().length === 0) {
      throw new Error(`${context}: Comment body cannot be empty`);
    }
    // GitHub API has a limit of ~65536 characters for comment body
    if (body.length > 65_536) {
      throw new Error(
        `${context}: Comment body too long (${body.length} chars, max 65536)`
      );
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      }
    );

    const rateLimitInfo = parseRateLimitHeaders(response);
    logRateLimitWarning(rateLimitInfo, context);

    if (!response.ok) {
      await handleApiError(response, rateLimitInfo, context, {
        404: "Issue/PR not found or app lacks permission to comment",
        422: "Validation failed - comment body may be invalid.",
      });
    }

    const data = (await response.json()) as CommentResponse;

    // Validate response has expected fields
    if (typeof data.id !== "number" || !data.html_url) {
      throw new Error(
        `${context}: Unexpected response format - missing id or html_url`
      );
    }

    console.log(`[github] ${context}: Posted comment ${data.id}`);
    return { id: data.id, htmlUrl: data.html_url };
  };

  // PATCH /repos/{owner}/{repo}/issues/comments/{comment_id} - update existing comment
  const updateComment = async (
    token: string,
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<void> => {
    const context = `updateComment(${owner}/${repo}, commentId=${commentId})`;

    // Validate inputs
    validateOwnerRepo(owner, repo, context);
    validateCommentId(commentId, context);
    if (!body || body.trim().length === 0) {
      throw new Error(`${context}: Comment body cannot be empty`);
    }
    if (body.length > 65_536) {
      throw new Error(
        `${context}: Comment body too long (${body.length} chars, max 65536)`
      );
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      }
    );

    const rateLimitInfo = parseRateLimitHeaders(response);
    logRateLimitWarning(rateLimitInfo, context);

    if (!response.ok) {
      await handleApiError(response, rateLimitInfo, context, {
        404: "Comment not found (may have been deleted)",
        422: "Validation failed - comment body may be invalid.",
      });
    }

    console.log(`[github] ${context}: Updated comment`);
  };

  return {
    getInstallationToken,
    getInstallationInfo,
    getInstallationRepos,
    fetchWorkflowLogs,
    postComment,
    pushCommit,
    getPullRequestForRun,
    getPullRequestForCommit,
    listWorkflowRunsForCommit,
    listJobsForWorkflowRun,
    createCheckRun,
    updateCheckRun,
    postCommentWithId,
    updateComment,
  };
};

// Public factory that returns cached singleton (token cache survives across calls)
export const createGitHubService = (env: Env): GitHubService => {
  // Return cached service if app ID matches (same env)
  if (cachedService && cachedAppId === env.GITHUB_APP_ID) {
    return cachedService;
  }

  // Create new service and cache it
  cachedService = createGitHubServiceInternal(env);
  cachedAppId = env.GITHUB_APP_ID;
  console.log("[github] Created new GitHubService instance (singleton)");

  return cachedService;
};

export type GitHubService = ReturnType<typeof createGitHubServiceInternal>;
