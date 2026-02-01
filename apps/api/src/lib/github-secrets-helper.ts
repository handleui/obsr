/**
 * GitHub Secrets Helper
 *
 * Shared utilities for creating GitHub Actions secrets via the GitHub API.
 * Used by both the manual injection endpoint and auto-creation during installation.
 *
 * Rate Limit Considerations:
 * - GitHub App installations have 5,000+ requests/hour primary limit
 * - Secondary limits: max 100 concurrent requests, 900 points/min
 * - Each secret creation = 2 API calls (GET public key + PUT secret)
 * - PUT requests cost 5 points each toward secondary limits
 */

import { encryptSecretForGitHub } from "./github-crypto";

const GITHUB_API = "https://api.github.com";

/**
 * Concurrency, timeout and retry configuration
 * - MAX_CONCURRENT: Stay well under GitHub's 100 concurrent request limit
 * - TIMEOUT_MS: Prevent hanging requests in waitUntil context
 * - MAX_RETRIES: Handle transient failures with exponential backoff
 */
const MAX_CONCURRENT = 10;
const TIMEOUT_MS = 15_000; // 15 seconds per request
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

/**
 * GitHub name validation pattern (org names, repo names).
 * GitHub org/repo names: alphanumeric, hyphens, underscores, dots.
 * Cannot start with dot or hyphen, max 100 chars.
 */
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Pattern to extract status code from GitHub API error messages
 */
const GITHUB_API_ERROR_STATUS_PATTERN = /GitHub API error: (\d+)/;

/**
 * Validate a GitHub organization or repository name.
 * Prevents URL injection attacks by ensuring names don't contain
 * path traversal sequences or URL-special characters.
 *
 * Logs detailed error reason for debugging while returning generic error to clients.
 */
const validateGitHubName = (name: string, fieldName: string): void => {
  if (!name || name.length === 0) {
    console.warn(
      `[github-secrets] ${fieldName} validation failed: empty value`
    );
    throw new Error(`Invalid ${fieldName}: cannot be empty`);
  }
  if (name.length > 100) {
    console.warn(
      `[github-secrets] ${fieldName} validation failed: exceeds max length (${name.length} > 100)`
    );
    throw new Error(`Invalid ${fieldName}: exceeds maximum length`);
  }
  if (!GITHUB_NAME_PATTERN.test(name)) {
    console.warn(
      `[github-secrets] ${fieldName} validation failed: invalid format "${name.slice(0, 50)}"`
    );
    throw new Error(
      `Invalid ${fieldName}: must start with alphanumeric and contain only alphanumeric, dots, hyphens, or underscores`
    );
  }
  // Additional check for path traversal
  if (name.includes("..") || name.includes("//")) {
    console.warn(
      `[github-secrets] ${fieldName} validation failed: contains path traversal sequence`
    );
    throw new Error(
      `Invalid ${fieldName}: contains invalid character sequence`
    );
  }
};

/**
 * Sanitize error messages to prevent information leakage.
 * Removes potentially sensitive details from GitHub API errors.
 */
const sanitizeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    // Check if it's a GitHub API error with sensitive info
    const msg = error.message;
    // Remove any tokens, keys, or detailed API responses
    if (msg.includes("GitHub API error:")) {
      // Extract just the status code, not the full response
      const statusMatch = msg.match(GITHUB_API_ERROR_STATUS_PATTERN);
      if (statusMatch) {
        return `GitHub API error: ${statusMatch[1]}`;
      }
      return "GitHub API error";
    }
    return msg;
  }
  return "Unknown error";
};

interface GitHubPublicKeyResponse {
  key_id: string;
  key: string;
}

interface GitHubApiError extends Error {
  status?: number;
  isRetryable: boolean;
}

const createGitHubApiError = (
  message: string,
  status?: number
): GitHubApiError => {
  const error = new Error(message) as GitHubApiError;
  error.status = status;
  // Retry on rate limits (403/429), server errors (5xx), and network issues
  error.isRetryable =
    status === undefined ||
    status === 403 ||
    status === 429 ||
    (status >= 500 && status < 600);
  return error;
};

/**
 * Fetch with timeout - prevents hanging requests in waitUntil context
 */
const fetchWithTimeout = async (
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Sleep utility for exponential backoff
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calculate retry delay with exponential backoff and jitter
 *
 * NOTE: Uses Math.random() for jitter which makes tests non-deterministic.
 * This is an acceptable trade-off because:
 * 1. Jitter is only used for rate limit avoidance (non-critical timing)
 * 2. The retry logic is well-tested via integration tests
 * 3. Injecting a random source adds complexity for minimal benefit
 */
const getRetryDelay = (attempt: number): number => {
  const baseDelay = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
  // Add 0-25% jitter to prevent thundering herd
  const jitter = Math.random() * 0.25 * baseDelay;
  return Math.min(baseDelay + jitter, 10_000); // Cap at 10 seconds
};

/**
 * Calculate wait time from rate limit response headers
 */
const getRateLimitWaitMs = (
  response: Response,
  defaultWaitMs: number
): number => {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    return Number.parseInt(retryAfter, 10) * 1000;
  }
  const rateLimitReset = response.headers.get("x-ratelimit-reset");
  if (rateLimitReset) {
    const resetTime = Number.parseInt(rateLimitReset, 10) * 1000;
    return Math.max(resetTime - Date.now(), 1000);
  }
  return defaultWaitMs;
};

/**
 * Execute a fetch request with timeout and proper headers
 */
const executeGitHubFetch = async (
  url: string,
  token: string,
  options: RequestInit
): Promise<Response> => {
  try {
    return await fetchWithTimeout(
      url,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Detent-App",
          ...options.headers,
        },
      },
      TIMEOUT_MS
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw createGitHubApiError(`GitHub API timeout after ${TIMEOUT_MS}ms`);
    }
    throw createGitHubApiError(
      `GitHub API network error: ${err instanceof Error ? err.message : "unknown"}`
    );
  }
};

/**
 * Process successful response and return JSON data.
 * Use this for GET requests that expect a response body.
 */
const processJsonResponse = <T>(response: Response): Promise<T> =>
  response.json() as Promise<T>;

/**
 * Process successful response that expects no content (201/204).
 * Use this for PUT/DELETE requests.
 */
const processVoidResponse = (response: Response): void => {
  // 201/204 responses have no content - nothing to return
  if (
    response.status !== 201 &&
    response.status !== 204 &&
    response.status !== 200
  ) {
    console.warn(
      `[github-secrets] Unexpected status ${response.status} for void response`
    );
  }
};

/** Sentinel value to signal retry */
const SHOULD_RETRY = Symbol("SHOULD_RETRY");

/**
 * Handle rate limit response - returns SHOULD_RETRY or throws
 */
const handleRateLimitResponse = async (
  response: Response,
  attempt: number
): Promise<typeof SHOULD_RETRY> => {
  const waitMs = getRateLimitWaitMs(response, getRetryDelay(attempt));
  if (attempt < MAX_RETRIES && waitMs <= 30_000) {
    console.log(
      `[github-secrets] Rate limited, waiting ${waitMs}ms before retry ${attempt + 1}/${MAX_RETRIES}`
    );
    await sleep(waitMs);
    return SHOULD_RETRY;
  }
  const errorText = await response.text();
  throw createGitHubApiError(
    `GitHub API rate limited: ${response.status} - ${errorText}`,
    response.status
  );
};

/**
 * Handle error response - returns SHOULD_RETRY or throws
 */
const handleErrorResponse = async (
  response: Response,
  attempt: number
): Promise<typeof SHOULD_RETRY> => {
  const errorText = await response.text();
  const error = createGitHubApiError(
    `GitHub API error: ${response.status} ${response.statusText} - ${errorText}`,
    response.status
  );
  if (error.isRetryable && attempt < MAX_RETRIES) {
    console.log(
      `[github-secrets] Server error ${response.status}, retrying ${attempt + 1}/${MAX_RETRIES}`
    );
    await sleep(getRetryDelay(attempt));
    return SHOULD_RETRY;
  }
  throw error;
};

/**
 * Convert caught error to GitHubApiError
 */
const toGitHubApiError = (err: unknown): GitHubApiError =>
  err instanceof Error && "isRetryable" in err
    ? (err as GitHubApiError)
    : createGitHubApiError(
        err instanceof Error ? err.message : "Unknown error"
      );

/**
 * Internal fetch with retry logic - returns JSON response
 */
const fetchGitHubApi = async <T>(
  url: string,
  token: string,
  options: RequestInit = {}
): Promise<T> => {
  let lastError: GitHubApiError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await executeGitHubFetch(url, token, options);

      // Handle rate limiting (403/429)
      if (response.status === 403 || response.status === 429) {
        const result = await handleRateLimitResponse(response, attempt);
        if (result === SHOULD_RETRY) {
          continue;
        }
      }

      // Handle other errors
      if (!response.ok) {
        const result = await handleErrorResponse(response, attempt);
        if (result === SHOULD_RETRY) {
          continue;
        }
      }

      return processJsonResponse<T>(response);
    } catch (err) {
      lastError = toGitHubApiError(err);
      if (!lastError.isRetryable || attempt >= MAX_RETRIES) {
        throw lastError;
      }
      console.log(
        `[github-secrets] Error: ${lastError.message}, retrying ${attempt + 1}/${MAX_RETRIES}`
      );
      await sleep(getRetryDelay(attempt));
    }
  }

  throw lastError || createGitHubApiError("Unknown error after retries");
};

/**
 * Internal fetch with retry logic - for PUT/DELETE operations that return no content
 */
const fetchGitHubApiVoid = async (
  url: string,
  token: string,
  options: RequestInit
): Promise<void> => {
  let lastError: GitHubApiError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await executeGitHubFetch(url, token, options);

      // Handle rate limiting (403/429)
      if (response.status === 403 || response.status === 429) {
        const result = await handleRateLimitResponse(response, attempt);
        if (result === SHOULD_RETRY) {
          continue;
        }
      }

      // Handle other errors
      if (!response.ok) {
        const result = await handleErrorResponse(response, attempt);
        if (result === SHOULD_RETRY) {
          continue;
        }
      }

      processVoidResponse(response);
      return;
    } catch (err) {
      lastError = toGitHubApiError(err);
      if (!lastError.isRetryable || attempt >= MAX_RETRIES) {
        throw lastError;
      }
      console.log(
        `[github-secrets] Error: ${lastError.message}, retrying ${attempt + 1}/${MAX_RETRIES}`
      );
      await sleep(getRetryDelay(attempt));
    }
  }

  throw lastError || createGitHubApiError("Unknown error after retries");
};

/**
 * Get the public key for encrypting organization secrets
 */
export const getOrgPublicKey = (
  orgLogin: string,
  token: string
): Promise<GitHubPublicKeyResponse> => {
  validateGitHubName(orgLogin, "organization name");
  return fetchGitHubApi<GitHubPublicKeyResponse>(
    `${GITHUB_API}/orgs/${encodeURIComponent(orgLogin)}/actions/secrets/public-key`,
    token
  );
};

/**
 * Get the public key for encrypting repository secrets
 */
export const getRepoPublicKey = (
  owner: string,
  repo: string,
  token: string
): Promise<GitHubPublicKeyResponse> => {
  validateGitHubName(owner, "owner name");
  validateGitHubName(repo, "repository name");
  return fetchGitHubApi<GitHubPublicKeyResponse>(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets/public-key`,
    token
  );
};

/**
 * GitHub secret name validation pattern.
 * Secret names: alphanumeric and underscores only, must start with letter.
 */
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Validate a GitHub secret name.
 * Logs detailed error reason for debugging.
 */
const validateSecretName = (name: string): void => {
  if (!name || name.length === 0) {
    console.warn("[github-secrets] secret name validation failed: empty value");
    throw new Error("Invalid secret name: cannot be empty");
  }
  if (name.length > 100) {
    console.warn(
      `[github-secrets] secret name validation failed: exceeds max length (${name.length} > 100)`
    );
    throw new Error("Invalid secret name: exceeds maximum length");
  }
  if (!SECRET_NAME_PATTERN.test(name)) {
    console.warn(
      `[github-secrets] secret name validation failed: invalid format "${name.slice(0, 50)}"`
    );
    throw new Error(
      "Invalid secret name: must start with uppercase letter and contain only uppercase letters, numbers, or underscores"
    );
  }
};

/**
 * Create or update an organization secret
 */
export const putOrgSecret = async (
  orgLogin: string,
  secretName: string,
  encryptedValue: string,
  keyId: string,
  visibility: "all" | "private" | "selected",
  token: string,
  repositoryIds?: number[]
): Promise<void> => {
  validateGitHubName(orgLogin, "organization name");
  validateSecretName(secretName);

  const body: Record<string, unknown> = {
    encrypted_value: encryptedValue,
    key_id: keyId,
    visibility,
  };

  if (visibility === "selected" && repositoryIds) {
    body.selected_repository_ids = repositoryIds;
  }

  await fetchGitHubApiVoid(
    `${GITHUB_API}/orgs/${encodeURIComponent(orgLogin)}/actions/secrets/${encodeURIComponent(secretName)}`,
    token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
};

/**
 * Create or update a repository secret
 */
export const putRepoSecret = async (
  owner: string,
  repo: string,
  secretName: string,
  encryptedValue: string,
  keyId: string,
  token: string
): Promise<void> => {
  validateGitHubName(owner, "owner name");
  validateGitHubName(repo, "repository name");
  validateSecretName(secretName);

  await fetchGitHubApiVoid(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets/${encodeURIComponent(secretName)}`,
    token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: keyId,
      }),
    }
  );
};

/**
 * Create DETENT_TOKEN as an organization secret (for GitHub orgs)
 */
export const createOrgSecret = async (
  orgLogin: string,
  apiKey: string,
  token: string,
  visibility: "all" | "private" | "selected" = "all",
  repositoryIds?: number[]
): Promise<void> => {
  const publicKey = await getOrgPublicKey(orgLogin, token);
  const encryptedValue = encryptSecretForGitHub(apiKey, publicKey.key);
  await putOrgSecret(
    orgLogin,
    "DETENT_TOKEN",
    encryptedValue,
    publicKey.key_id,
    visibility,
    token,
    repositoryIds
  );
};

/**
 * Create DETENT_TOKEN as a repository secret (for personal accounts)
 */
export const createRepoSecret = async (
  repoFullName: string,
  apiKey: string,
  token: string
): Promise<void> => {
  // Validate format first - should be exactly "owner/repo"
  if (!repoFullName || typeof repoFullName !== "string") {
    console.warn(
      "[github-secrets] repository name validation failed: empty or invalid type"
    );
    throw new Error("Invalid repository name: cannot be empty");
  }
  const parts = repoFullName.split("/");
  if (parts.length !== 2) {
    console.warn(
      `[github-secrets] repository name validation failed: invalid format "${repoFullName.slice(0, 50)}"`
    );
    throw new Error("Invalid repository name: must be in format 'owner/repo'");
  }
  const [owner, repo] = parts;
  if (!(owner && repo)) {
    console.warn(
      `[github-secrets] repository name validation failed: empty owner or repo in "${repoFullName}"`
    );
    throw new Error("Invalid repository name: owner and repo cannot be empty");
  }
  // Validation of owner/repo happens in getRepoPublicKey and putRepoSecret
  const publicKey = await getRepoPublicKey(owner, repo, token);
  const encryptedValue = encryptSecretForGitHub(apiKey, publicKey.key);
  await putRepoSecret(
    owner,
    repo,
    "DETENT_TOKEN",
    encryptedValue,
    publicKey.key_id,
    token
  );
};

/**
 * Result of a batch secret creation operation
 */
export interface BatchSecretResult {
  succeeded: number;
  failed: number;
  errors: Array<{ repo: string; error: string }>;
}

/**
 * Create DETENT_TOKEN secrets for multiple repos with concurrency control
 * Uses batched execution to stay within GitHub's secondary rate limits:
 * - Max 10 concurrent requests (each repo = 2 API calls)
 * - Respects 100 concurrent request limit
 * - Respects 900 points/min limit (PUT = 5 points each)
 */
export const createRepoSecretsBatched = async (
  repositories: Array<{ full_name: string }>,
  apiKey: string,
  token: string
): Promise<BatchSecretResult> => {
  const results: BatchSecretResult = {
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  // Process in batches with concurrency limit
  for (let i = 0; i < repositories.length; i += MAX_CONCURRENT) {
    const batch = repositories.slice(i, i + MAX_CONCURRENT);

    const batchResults = await Promise.allSettled(
      batch.map((repo) => createRepoSecret(repo.full_name, apiKey, token))
    );

    batchResults.forEach((result, j) => {
      const repo = batch[j];
      if (result.status === "fulfilled") {
        results.succeeded++;
      } else if (repo) {
        results.failed++;
        results.errors.push({
          repo: repo.full_name,
          error: sanitizeErrorMessage(result.reason),
        });
      }
    });

    // Add a small delay between batches to avoid rate limit pressure
    // Only if there are more batches to process
    if (i + MAX_CONCURRENT < repositories.length) {
      await sleep(500);
    }
  }

  return results;
};

/**
 * Result of creating a DETENT_TOKEN with API key management
 */
export interface CreateTokenSecretResult {
  /** API key ID stored in database */
  keyId: string;
  /** Whether any secrets were successfully created */
  secretsCreated: boolean;
  /** Batch results for repo-level secrets (undefined for org-level) */
  batchResult?: BatchSecretResult;
}

import type { ConvexHttpClient } from "convex/browser";

/**
 * Create DETENT_TOKEN secrets with API key lifecycle management.
 *
 * This is the canonical helper for creating GitHub secrets with proper cleanup:
 * - Generates and stores API key in database
 * - Creates org-level or repo-level secrets based on account type
 * - Cleans up orphaned API keys if ALL secret creations fail
 * - Preserves API key on partial success (some secrets created)
 *
 * Used by both installation handlers and the manual injection endpoint.
 */
export const createTokenSecretWithCleanup = async ({
  convex,
  organizationId,
  providerAccountLogin,
  providerAccountType,
  token,
  repositories,
  keyName,
}: {
  /** Convex client */
  convex: ConvexHttpClient;
  /** Detent organization ID */
  organizationId: string;
  /** GitHub account login (username or org name) */
  providerAccountLogin: string;
  /** Account type determines org-level vs repo-level secrets */
  providerAccountType: "organization" | "user";
  /** GitHub installation token */
  token: string;
  /** Repositories for repo-level secrets (required for user accounts) */
  repositories: Array<{ full_name: string }>;
  /** Name for the API key record */
  keyName: string;
}): Promise<CreateTokenSecretResult> => {
  // Import crypto functions here to avoid circular dependencies
  const { generateApiKey, hashApiKey } = await import("./crypto");

  const apiKey = generateApiKey();
  const keyHash = await hashApiKey(apiKey);
  const keyPrefix = apiKey.substring(0, 8);

  const keyId = (await convex.mutation("api-keys:create", {
    organizationId,
    keyHash,
    keyPrefix,
    name: keyName,
    createdAt: Date.now(),
  })) as string;

  let secretsCreated = false;
  let batchResult: BatchSecretResult | undefined;

  try {
    if (providerAccountType === "organization") {
      // Organization: single org-level secret covers all repos
      await createOrgSecret(providerAccountLogin, apiKey, token);
      secretsCreated = true;
    } else {
      // Personal account: must create repo-level secret for each repo
      batchResult = await createRepoSecretsBatched(repositories, apiKey, token);
      secretsCreated = batchResult.succeeded > 0;

      // If ALL repos failed, clean up the orphaned API key
      if (batchResult.succeeded === 0 && repositories.length > 0) {
        await convex.mutation("api-keys:remove", { id: keyId });
        throw new Error(
          `All ${repositories.length} repo secret creations failed for ${providerAccountLogin}`
        );
      }
    }

    return { keyId, secretsCreated, batchResult };
  } catch (error) {
    // Only clean up API key if no secrets were created
    if (!secretsCreated) {
      try {
        await convex.mutation("api-keys:remove", { id: keyId });
      } catch (deleteError) {
        console.error(
          `[github-secrets] ORPHAN_KEY: Failed to delete API key ${keyId} for org ${organizationId}:`,
          deleteError
        );
      }
    }
    throw error;
  }
};

// Export sanitizeErrorMessage for use in handlers
export { sanitizeErrorMessage };
