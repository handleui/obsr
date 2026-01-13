import type { Env } from "../types/env";
import {
  blobToArrayBuffer,
  extractLogsFromZip,
  type LogExtractionResult,
} from "./log-extractor";

// GitHub App API service
// Handles: JWT generation, installation tokens, API calls

const GITHUB_API = "https://api.github.com";

// Top-level regex constants for performance
const PEM_BEGIN_RSA = /-----BEGIN RSA PRIVATE KEY-----/;
const PEM_END_RSA = /-----END RSA PRIVATE KEY-----/;
const PEM_BEGIN_PKCS8 = /-----BEGIN PRIVATE KEY-----/;
const PEM_END_PKCS8 = /-----END PRIVATE KEY-----/;
const WHITESPACE = /\s/g;
const BASE64_TRAILING_EQUALS = /=+$/;

// Validation patterns for GitHub identifiers
// Owner/repo names: alphanumeric, hyphen, underscore, period (not starting with period)
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;
// Branch names: more permissive but no path traversal
const GITHUB_BRANCH_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._/]*$/;
// Git SHA: 40-character hexadecimal (full SHA) or 7+ character short SHA
const GIT_SHA_PATTERN = /^[a-fA-F0-9]{7,40}$/;

const isValidGitHubName = (name: string): boolean => {
  return (
    name.length > 0 &&
    name.length <= 100 &&
    GITHUB_NAME_PATTERN.test(name) &&
    !name.includes("..")
  );
};

const isValidBranchName = (branch: string): boolean => {
  return (
    branch.length > 0 &&
    branch.length <= 255 &&
    GITHUB_BRANCH_PATTERN.test(branch) &&
    !branch.includes("..") &&
    !branch.startsWith("/") &&
    !branch.endsWith("/")
  );
};

const isValidGitSha = (sha: string): boolean => {
  return GIT_SHA_PATTERN.test(sha);
};

// Rate limit information extracted from GitHub API response headers
interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
  isExceeded: boolean;
}

// Parse rate limit headers from GitHub API response
const parseRateLimitHeaders = (response: Response): RateLimitInfo | null => {
  const limit = response.headers.get("x-ratelimit-limit");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");

  if (!(limit && remaining && reset)) {
    return null;
  }

  const resetTimestamp = Number.parseInt(reset, 10) * 1000; // Convert to milliseconds
  return {
    limit: Number.parseInt(limit, 10),
    remaining: Number.parseInt(remaining, 10),
    reset: new Date(resetTimestamp),
    isExceeded: Number.parseInt(remaining, 10) === 0,
  };
};

// Log rate limit warning if remaining requests are low
const logRateLimitWarning = (
  rateLimitInfo: RateLimitInfo | null,
  context: string
): void => {
  if (!rateLimitInfo) {
    return;
  }

  const { remaining, limit, reset } = rateLimitInfo;
  const percentRemaining = (remaining / limit) * 100;

  // Warn if less than 10% of rate limit remaining
  if (percentRemaining < 10) {
    console.warn(
      `[github] Rate limit warning for ${context}: ${remaining}/${limit} remaining (resets at ${reset.toISOString()})`
    );
  }
};

// Create enhanced error with rate limit context
const createRateLimitError = (
  response: Response,
  rateLimitInfo: RateLimitInfo | null,
  context: string
): Error => {
  if (rateLimitInfo?.isExceeded) {
    const retryAfter = response.headers.get("retry-after");
    const resetTime = rateLimitInfo.reset.toISOString();
    return new Error(
      `Rate limit exceeded for ${context}. ` +
        `Resets at ${resetTime}` +
        (retryAfter ? `. Retry after ${retryAfter}s` : "")
    );
  }
  return new Error(`GitHub API error for ${context}: ${response.status}`);
};

// Common validation for owner/repo
const validateOwnerRepo = (
  owner: string,
  repo: string,
  context: string
): void => {
  if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
    throw new Error(`${context}: Invalid owner or repo name`);
  }
};

// Common validation for git SHA
const validateGitSha = (sha: string, context: string): void => {
  if (!isValidGitSha(sha)) {
    throw new Error(
      `${context}: Invalid SHA format. Expected 7-40 character hex string`
    );
  }
};

// Handle common GitHub API error responses and throw appropriate errors
const handleApiError = async (
  response: Response,
  rateLimitInfo: RateLimitInfo | null,
  context: string,
  errorMessages: { 404?: string; 422?: string }
): Promise<never> => {
  // Check for rate limit errors
  if (
    (response.status === 403 || response.status === 429) &&
    rateLimitInfo?.isExceeded
  ) {
    throw createRateLimitError(response, rateLimitInfo, context);
  }

  const error = await response.text();

  // Provide more specific error messages for common failures
  if (response.status === 404 && errorMessages[404]) {
    throw new Error(`${context}: ${errorMessages[404]}`);
  }
  if (response.status === 422 && errorMessages[422]) {
    throw new Error(`${context}: ${errorMessages[422]} ${error}`);
  }

  throw new Error(
    `${context}: API request failed - ${response.status} ${error}`
  );
};

interface GitHubServiceConfig {
  appId: string;
  privateKey: string;
}

// Convert PEM to ArrayBuffer for Web Crypto API
const pemToArrayBuffer = (pem: string): ArrayBuffer => {
  const base64 = pem
    .replace(PEM_BEGIN_RSA, "")
    .replace(PEM_END_RSA, "")
    .replace(PEM_BEGIN_PKCS8, "")
    .replace(PEM_END_PKCS8, "")
    .replace(WHITESPACE, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// Base64URL encode (JWT-safe)
const base64UrlEncode = (data: ArrayBuffer | string): string => {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const binary = Array.from(new Uint8Array(bytes))
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(BASE64_TRAILING_EQUALS, "");
};

// Generate JWT for GitHub App authentication (RS256)
const generateAppJwt = async (config: GitHubServiceConfig): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60, // 60 seconds in the past to account for clock drift
    exp: now + 600, // 10 minutes from now (max allowed)
    iss: config.appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  // Import the private key
  const keyData = pemToArrayBuffer(config.privateKey);

  // Try PKCS#8 first, fall back to PKCS#1
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
  } catch {
    // GitHub generates PKCS#1 keys, need to convert or use different format
    throw new Error(
      "Failed to import private key. Ensure it's in PKCS#8 format. " +
        "Convert with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem"
    );
  }

  // Sign the JWT
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncode(signature)}`;
};

// API response types
interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

interface WorkflowRunResponse {
  pull_requests: Array<{ number: number }>;
}

interface GitTreeItem {
  path: string;
  mode: "100644";
  type: "blob";
  content: string;
}

interface CreateTreeResponse {
  sha: string;
}

interface CreateCommitResponse {
  sha: string;
}

interface RefResponse {
  object: { sha: string };
}

interface InstallationInfo {
  id: number;
  account: {
    id: number;
    login: string;
    type: "Organization" | "User";
    avatar_url?: string;
  };
  suspended_at: string | null;
}

interface InstallationReposResponse {
  total_count: number;
  repositories: Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    default_branch: string;
  }>;
}

interface WorkflowRunsResponse {
  workflow_runs: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_branch: string;
    run_attempt: number;
    run_started_at: string | null;
    // Note: GitHub doesn't have run_completed_at, we use receivedAt instead
  }>;
}

interface CheckRunResponse {
  id: number;
  html_url: string;
}

interface CommentResponse {
  id: number;
  html_url: string;
}

// Module-level cache for installation tokens (survives across function calls within isolate)
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

// Module-level singleton for GitHub service instance
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
  // Returns all workflow runs for a commit and whether they're all completed
  // Includes metadata for run tracking (branch, attempt, timing)
  const listWorkflowRunsForCommit = async (
    token: string,
    owner: string,
    repo: string,
    headSha: string
  ): Promise<{
    allCompleted: boolean;
    runs: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      headBranch: string;
      runAttempt: number;
      runStartedAt: Date | null;
    }>;
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
    const runs = workflowRuns.map((run) => ({
      id: run.id,
      name: run.name ?? "Unknown",
      status: run.status ?? "unknown",
      conclusion: run.conclusion,
      headBranch: run.head_branch ?? "unknown",
      runAttempt: run.run_attempt ?? 1,
      runStartedAt: run.run_started_at ? new Date(run.run_started_at) : null,
    }));

    // Empty runs array means no workflows configured or SHA not found
    // Consider this as "all completed" since there's nothing to wait for
    const allCompleted =
      runs.length === 0 || runs.every((run) => run.status === "completed");

    console.log(
      `[github] ${context}: Found ${runs.length} workflow runs, allCompleted=${allCompleted}`
    );

    return { allCompleted, runs };
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

  // GitHub Check Run Annotation
  // See: https://docs.github.com/en/rest/checks/runs#update-a-check-run
  //
  // Annotation levels:
  // - "failure": Blocks PR merging (if branch protection requires checks), shown as red X
  // - "warning": Shows warning icon (yellow), does not block
  // - "notice": Informational (blue info icon), does not block
  interface CheckRunAnnotation {
    path: string;
    start_line: number;
    end_line: number;
    start_column?: number; // Column precision (same line only)
    end_column?: number;
    annotation_level: "notice" | "warning" | "failure";
    message: string; // Max 64 KB
    title?: string; // Max 255 chars
    raw_details?: string; // Max 64 KB - additional context (stack traces, etc.)
  }

  // Check run output with optional detailed text and annotations
  interface CheckRunOutput {
    title: string;
    summary: string;
    text?: string;
    annotations?: CheckRunAnnotation[];
  }

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
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`${context}: Invalid issue number`);
    }
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
    if (!Number.isInteger(commentId) || commentId <= 0) {
      throw new Error(`${context}: Invalid comment ID`);
    }
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
    listWorkflowRunsForCommit,
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
