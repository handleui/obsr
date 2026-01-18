import {
  handleApiError,
  hasRateLimitHeadroom,
  logRateLimitWarning,
  parseRateLimitHeaders,
} from "./rate-limit";
import type { GitHubContentsResponse } from "./types";
import {
  GITHUB_API,
  validateFilePath,
  validateGitSha,
  validateOwnerRepo,
} from "./validation";

export interface FileContentResult {
  content: string;
  path: string;
  sha: string;
  size: number;
}

/** Number of concurrent requests for parallel fetching (balance speed vs rate limits) */
const PARALLEL_BATCH_SIZE = 5;

/**
 * Fetch single file content from GitHub Contents API.
 * Returns null for 404 (file doesn't exist at that commit).
 *
 * GET /repos/{owner}/{repo}/contents/{path}?ref={sha}
 */
export const fetchFileContent = async (
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<FileContentResult | null> => {
  const context = `fetchFileContent(${owner}/${repo}, path=${path}, ref=${ref.slice(0, 7)})`;

  validateOwnerRepo(owner, repo, context);
  validateGitSha(ref, context);

  // Validate and normalize path to prevent traversal attacks
  const validatedPath = validateFilePath(path, context);

  // Encode path segments to handle special characters
  const encodedPath = validatedPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${ref}`,
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

  // 404 means file doesn't exist at this commit - return null
  if (response.status === 404) {
    console.log(`[github] ${context}: File not found`);
    return null;
  }

  if (!response.ok) {
    await handleApiError(response, rateLimitInfo, context, {});
  }

  const data = (await response.json()) as GitHubContentsResponse;

  // Validate response is a file (not directory)
  if (data.type !== "file") {
    throw new Error(`${context}: Path is not a file (type: ${data.type})`);
  }

  // Decode base64 content
  const decodedContent = decodeBase64Content(data.content);

  console.log(
    `[github] ${context}: Fetched ${data.size} bytes (${decodedContent.length} chars decoded)`
  );

  return {
    content: decodedContent,
    path: data.path,
    sha: data.sha,
    size: data.size,
  };
};

/**
 * Batch fetch multiple file contents with deduplication.
 * Uses parallel batched fetching for better performance while respecting rate limits.
 * Processes files in batches of PARALLEL_BATCH_SIZE, checking rate limits between batches.
 * Returns partial results if rate limit headroom is exhausted.
 */
export const fetchFileContents = async (
  token: string,
  owner: string,
  repo: string,
  paths: string[],
  ref: string
): Promise<Map<string, FileContentResult>> => {
  const context = `fetchFileContents(${owner}/${repo}, ${paths.length} files, ref=${ref.slice(0, 7)})`;

  validateOwnerRepo(owner, repo, context);
  validateGitSha(ref, context);

  // Deduplicate paths using Set
  const uniquePaths = [...new Set(paths)];

  // Early exit for empty input
  if (uniquePaths.length === 0) {
    return new Map();
  }

  const results = new Map<string, FileContentResult>();

  console.log(
    `[github] ${context}: Fetching ${uniquePaths.length} unique files (${paths.length} requested)`
  );

  // Process in parallel batches for better performance
  // Check rate limit headroom before each batch
  for (let i = 0; i < uniquePaths.length; i += PARALLEL_BATCH_SIZE) {
    // Check rate limit headroom before each batch
    if (!hasRateLimitHeadroom()) {
      console.warn(
        `[github] ${context}: Stopping batch - rate limit headroom exhausted after ${results.size}/${uniquePaths.length} files`
      );
      break;
    }

    const batch = uniquePaths.slice(i, i + PARALLEL_BATCH_SIZE);
    const batchResults = await fetchBatch(token, owner, repo, batch, ref);

    // Merge batch results into main results
    for (const [path, result] of batchResults) {
      results.set(path, result);
    }
  }

  console.log(
    `[github] ${context}: Fetched ${results.size}/${uniquePaths.length} files`
  );

  return results;
};

/**
 * Decode base64 content from GitHub API response.
 * GitHub returns content with newlines every 60 characters.
 * Uses regex replace for better performance on large strings.
 *
 * Note: Manual byte-by-byte decoding is used instead of Buffer.from() because
 * Cloudflare Workers runtime doesn't have Node.js Buffer API. We use atob()
 * to decode base64, then manually convert to Uint8Array for TextDecoder.
 */
const decodeBase64Content = (content: string): string => {
  // Remove newlines that GitHub adds to base64 encoding
  // Use regex with global flag - more efficient than split/join for large strings
  const cleanedContent = content.replace(/\n/g, "");

  // Decode base64 to UTF-8 using Web APIs (Workers-compatible)
  const binaryString = atob(cleanedContent);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
};

/**
 * Process a batch of file fetches in parallel.
 * Returns results for successfully fetched files.
 */
const fetchBatch = async (
  token: string,
  owner: string,
  repo: string,
  paths: string[],
  ref: string
): Promise<Map<string, FileContentResult>> => {
  const results = new Map<string, FileContentResult>();

  const promises = paths.map(async (path) => {
    const result = await fetchFileContent(token, owner, repo, path, ref);
    return { path, result };
  });

  const settled = await Promise.allSettled(promises);

  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value.result) {
      results.set(outcome.value.path, outcome.value.result);
    }
  }

  return results;
};
