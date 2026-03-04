import { CACHE_TTL, cacheKey, getFromCache, setInCache } from "../../lib/cache";
import type { Env } from "../../types/env";
import type { LogExtractionResult } from "../log-extractor";
import { blobToArrayBuffer, extractLogsFromZip } from "../log-extractor";
import { generateAppJwt } from "./jwt";
import {
  createRateLimitError,
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
  GitHubOrgMember,
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

// Module-level token cache. Survives across calls within a Worker isolate.
// Tokens are short-lived (1hr); isolate recycling provides natural cache invalidation.
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

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
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      console.log(
        `[github] Token cache hit for installation ${installationId}`
      );
      return cached.token;
    }

    const jwt = await generateAppJwt(config);
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

    validateOwnerRepo(owner, repo, context);

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

  const getBranchSha = async (
    headers: Record<string, string>,
    owner: string,
    repo: string,
    branch: string
  ): Promise<string> => {
    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      { headers }
    );
    if (!response.ok) {
      throw new Error(`Failed to get branch ref: ${response.status}`);
    }
    const data = (await response.json()) as RefResponse;
    return data.object.sha;
  };

  const createGitTree = async (
    headers: Record<string, string>,
    owner: string,
    repo: string,
    baseSha: string,
    files: Array<{ path: string; content: string }>
  ): Promise<string> => {
    const treeItems: GitTreeItem[] = files.map((file) => ({
      path: file.path,
      mode: "100644" as const,
      type: "blob" as const,
      content: file.content,
    }));

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ base_tree: baseSha, tree: treeItems }),
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to create tree: ${response.status}`);
    }
    const data = (await response.json()) as CreateTreeResponse;
    return data.sha;
  };

  const createGitCommit = async (
    headers: Record<string, string>,
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parentSha: string
  ): Promise<string> => {
    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/commits`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to create commit: ${response.status}`);
    }
    const data = (await response.json()) as CreateCommitResponse;
    return data.sha;
  };

  const updateBranchRef = async (
    headers: Record<string, string>,
    owner: string,
    repo: string,
    branch: string,
    sha: string
  ): Promise<void> => {
    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ sha }),
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to update ref: ${response.status}`);
    }
  };

  const pushCommit = async (
    token: string,
    owner: string,
    repo: string,
    branch: string,
    message: string,
    files: Array<{ path: string; content: string }>
  ): Promise<string> => {
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

    const baseSha = await getBranchSha(headers, owner, repo, branch);
    const treeSha = await createGitTree(headers, owner, repo, baseSha, files);
    const commitSha = await createGitCommit(
      headers,
      owner,
      repo,
      message,
      treeSha,
      baseSha
    );
    await updateBranchRef(headers, owner, repo, branch, commitSha);

    console.log(
      `[github] Pushed commit ${commitSha.slice(0, 7)} to ${owner}/${repo}:${branch}`
    );

    return commitSha;
  };

  const getPullRequestForRun = async (
    token: string,
    owner: string,
    repo: string,
    runId: number
  ): Promise<number | null> => {
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

  const getPullRequestForCommit = async (
    token: string,
    owner: string,
    repo: string,
    sha: string
  ): Promise<number | null> => {
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

    const openPr = prs.find((pr) => pr.state === "open");
    return openPr?.number ?? prs[0]?.number ?? null;
  };

  const getPullRequestInfo = async (
    token: string,
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<{ headBranch: string; headSha: string } | null> => {
    const context = `getPullRequestInfo(${owner}/${repo}#${prNumber})`;

    if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
      throw new Error(`${context}: Invalid owner or repo name`);
    }

    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`${context}: Invalid PR number`);
    }

    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
        },
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`${context}: Failed to get PR info: ${response.status}`);
    }

    const data = (await response.json()) as {
      head: {
        ref: string;
        sha: string;
      };
    };

    return {
      headBranch: data.head.ref,
      headSha: data.head.sha,
    };
  };

  const getInstallationInfo = async (
    installationId: number
  ): Promise<InstallationInfo | null> => {
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

      if (allRepos.length >= data.total_count) {
        break;
      }
      page++;
    }

    return allRepos;
  };

  const fetchOrgMembersFromGitHub = async (
    token: string,
    orgLogin: string,
    context: string
  ): Promise<GitHubOrgMember[]> => {
    const allMembers: GitHubOrgMember[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const response = await fetch(
        `${GITHUB_API}/orgs/${encodeURIComponent(orgLogin)}/members?per_page=${perPage}&page=${page}`,
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

      if (response.status === 403 && rateLimitInfo?.isExceeded) {
        throw createRateLimitError(response, rateLimitInfo, context);
      }
      if (response.status === 403) {
        const error = await response.text();
        throw new Error(
          `GitHub App lacks members:read permission for ${orgLogin}: ${error}`
        );
      }

      if (!response.ok) {
        await handleApiError(response, rateLimitInfo, context, {
          404: "Organization not found",
        });
      }

      const members = (await response.json()) as GitHubOrgMember[];
      allMembers.push(...members);

      if (members.length < perPage) {
        break;
      }
      page++;
    }

    console.log(
      `[github] ${context}: Fetched ${allMembers.length} members (${page} pages)`
    );
    return allMembers;
  };

  const getOrgMembers = async (
    installationId: number,
    orgLogin: string
  ): Promise<GitHubOrgMember[]> => {
    const context = `getOrgMembers(${orgLogin})`;
    const membersCacheKey = cacheKey.githubOrgMembers(orgLogin);
    const cached = getFromCache<GitHubOrgMember[]>(membersCacheKey);
    if (cached) {
      console.log(`[github] ${context}: Cache hit (${cached.length} members)`);
      return cached;
    }

    try {
      const kvCached = await env["detent-idempotency"].get(
        membersCacheKey,
        "json"
      );
      if (kvCached) {
        const members = kvCached as GitHubOrgMember[];
        setInCache(membersCacheKey, members, CACHE_TTL.GITHUB_ORG_MEMBERS);
        console.log(
          `[github] ${context}: KV cache hit (${members.length} members)`
        );
        return members;
      }
    } catch (kvError) {
      console.warn(
        `[github] ${context}: KV read failed, fetching fresh:`,
        kvError
      );
    }

    const token = await getInstallationToken(installationId);
    const allMembers = await fetchOrgMembersFromGitHub(
      token,
      orgLogin,
      context
    );

    setInCache(membersCacheKey, allMembers, CACHE_TTL.GITHUB_ORG_MEMBERS);

    env["detent-idempotency"]
      .put(membersCacheKey, JSON.stringify(allMembers), {
        expirationTtl: 3600, // 1 hour
      })
      .catch((kvError) => {
        console.error(`[github] ${context}: KV write failed:`, kvError);
      });

    return allMembers;
  };

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
      completedAt: job.completed_at ? new Date(job.completed_at) : null,
      htmlUrl: job.html_url ?? null,
      workflowName: job.workflow_name ?? null,
      headBranch: job.head_branch ?? null,
      runnerName: job.runner_name ?? null,
      steps: job.steps?.map((step) => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        number: step.number,
        startedAt: step.started_at ? new Date(step.started_at) : null,
        completedAt: step.completed_at ? new Date(step.completed_at) : null,
      })),
    }));

    const now = Date.now();
    const evaluation = evaluateJobs(jobs, now);

    console.log(
      `[github] ${context}: Found ${jobs.length} jobs (${evaluation.pendingJobs.length} pending, ${evaluation.failedJobs.length} failed, ${evaluation.successJobs.length} passed)${
        evaluation.stuckJobs.length > 0
          ? `, WARNING: ${evaluation.stuckJobs.length} may be stuck (>30m)`
          : ""
      }`
    );

    return { jobs, evaluation };
  };

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

    validateOwnerRepo(owner, repo, context);
    validateGitSha(headSha, context);
    if (!name || name.trim().length === 0) {
      throw new Error(`${context}: Check run name cannot be empty`);
    }
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

  const updateCheckRun = async (
    token: string,
    options:
      | {
          owner: string;
          repo: string;
          checkRunId: number;
          status: "completed";
          conclusion:
            | "success"
            | "failure"
            | "neutral"
            | "cancelled"
            | "skipped"
            | "timed_out";
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

    validateOwnerRepo(owner, repo, context);
    if (!Number.isInteger(checkRunId) || checkRunId <= 0) {
      throw new Error(`${context}: Invalid check run ID`);
    }

    const body: Record<string, unknown> = {
      status,
      ...(output && { output }),
    };

    if (status === "completed") {
      body.conclusion = (
        options as {
          conclusion:
            | "success"
            | "failure"
            | "neutral"
            | "cancelled"
            | "skipped"
            | "timed_out";
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

  const postCommentWithId = async (
    token: string,
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ id: number; htmlUrl: string }> => {
    const context = `postCommentWithId(${owner}/${repo}#${issueNumber})`;

    validateOwnerRepo(owner, repo, context);
    validateIssueNumber(issueNumber, context);
    if (!body || body.trim().length === 0) {
      throw new Error(`${context}: Comment body cannot be empty`);
    }
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

    if (typeof data.id !== "number" || !data.html_url) {
      throw new Error(
        `${context}: Unexpected response format - missing id or html_url`
      );
    }

    console.log(`[github] ${context}: Posted comment ${data.id}`);
    return { id: data.id, htmlUrl: data.html_url };
  };

  const updateComment = async (
    token: string,
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<void> => {
    const context = `updateComment(${owner}/${repo}, commentId=${commentId})`;

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

  const addReactionToComment = async (
    token: string,
    owner: string,
    repo: string,
    commentId: number,
    reaction:
      | "eyes"
      | "confused"
      | "+1"
      | "-1"
      | "laugh"
      | "hooray"
      | "heart"
      | "rocket"
  ): Promise<void> => {
    const context = `addReactionToComment(${owner}/${repo}, commentId=${commentId})`;

    try {
      validateOwnerRepo(owner, repo, context);
      validateCommentId(commentId, context);

      const response = await fetch(
        `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Detent-App",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: reaction }),
        }
      );

      if (response.status === 201) {
        console.log(`[github] ${context}: Added "${reaction}" reaction`);
        return;
      }

      if (response.status === 200) {
        console.log(
          `[github] ${context}: Reaction "${reaction}" already exists`
        );
        return;
      }

      if (response.status === 422) {
        const error = await response.text();
        console.warn(`[github] ${context}: Reaction rejected (422): ${error}`);
        return;
      }

      const error = await response.text();
      console.error(
        `[github] ${context}: Failed to add reaction: ${response.status} ${error}`
      );
    } catch (error) {
      console.error(`[github] ${context}: Error adding reaction:`, error);
    }
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
    getPullRequestInfo,
    listWorkflowRunsForCommit,
    listJobsForWorkflowRun,
    createCheckRun,
    updateCheckRun,
    postCommentWithId,
    updateComment,
    getOrgMembers,
    addReactionToComment,
  };
};

export const createGitHubService = (env: Env): GitHubService => {
  if (cachedService && cachedAppId === env.GITHUB_APP_ID) {
    return cachedService;
  }

  cachedService = createGitHubServiceInternal(env);
  cachedAppId = env.GITHUB_APP_ID;
  console.log("[github] Created new GitHubService instance (singleton)");

  return cachedService;
};

export type GitHubService = ReturnType<typeof createGitHubServiceInternal>;

export type {
  CommitPushOptions,
  CommitPushResult,
  FileChange,
  PushResolveOptions,
} from "./commit-push";
// biome-ignore lint/performance/noBarrelFile: Re-exports needed for standalone functions
export { getBranchHead, pushCommit, pushResolveCommit } from "./commit-push";
export { fetchFileContent, fetchFileContents } from "./file-content";
