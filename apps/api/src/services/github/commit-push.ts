import {
  handleApiError,
  logRateLimitWarning,
  parseRateLimitHeaders,
} from "./rate-limit";
import type {
  CreateCommitResponse,
  CreateTreeResponse,
  RefResponse,
} from "./types";
import {
  GITHUB_API,
  isValidBranchName,
  validateGitSha,
  validateOwnerRepo,
} from "./validation";

export interface FileChange {
  path: string;
  content: string | null; // null = delete file
  mode?: "100644" | "100755" | "040000" | "160000" | "120000";
}

export interface CommitPushOptions {
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  message: string;
  files: FileChange[];
  force?: boolean; // Force push even if not fast-forward
  verifyBaseSha?: boolean; // Verify baseSha matches branch HEAD (default: true)
}

export interface CommitPushResult {
  sha: string;
  url: string;
}

interface GitTreeItem {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob";
  content?: string; // Omit for deletions
  sha?: string | null; // null = delete file
}

/**
 * Push a commit to a GitHub branch using the Data API.
 *
 * Flow:
 * 1. Create blobs for each file
 * 2. Create a new tree with the blobs
 * 3. Create a commit pointing to the tree
 * 4. Update the branch ref
 *
 * This works entirely via API - no git binary needed.
 */
export const pushCommit = async (
  token: string,
  options: CommitPushOptions
): Promise<CommitPushResult> => {
  const {
    owner,
    repo,
    branch,
    baseSha,
    message,
    files,
    force = false,
    verifyBaseSha = true,
  } = options;
  const context = `pushCommit(${owner}/${repo}:${branch}, baseSha=${baseSha.slice(0, 7)})`;

  validateOwnerRepo(owner, repo, context);
  validateGitSha(baseSha, context);

  if (!isValidBranchName(branch)) {
    throw new Error(`${context}: Invalid branch name`);
  }

  if (files.length === 0) {
    throw new Error(`${context}: No files to commit`);
  }

  if (!message || message.trim().length === 0) {
    throw new Error(`${context}: Commit message cannot be empty`);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Detent-App",
    "Content-Type": "application/json",
  };

  // Verify baseSha matches branch HEAD (conflict detection)
  if (verifyBaseSha) {
    const currentHead = await getBranchHead(token, owner, repo, branch);
    if (currentHead !== baseSha) {
      throw new Error(
        `${context}: Conflict detected - baseSha ${baseSha.slice(0, 7)} does not match branch HEAD ${currentHead.slice(0, 7)}. Branch has moved since baseSha was created. Use force=true to override or update baseSha.`
      );
    }
  }

  // Build tree items with content (GitHub creates blobs automatically)
  const treeItems: GitTreeItem[] = files.map((file) => {
    // Check for large files (GitHub's limit is 100MB)
    const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
    if (file.content && file.content.length > MAX_FILE_SIZE) {
      throw new Error(
        `${context}: File ${file.path} exceeds GitHub's 100MB blob limit (${(file.content.length / 1024 / 1024).toFixed(2)}MB)`
      );
    }

    // Handle file deletions
    if (file.content === null) {
      return {
        path: file.path,
        mode: file.mode ?? "100644",
        type: "blob" as const,
        sha: null, // null = delete file
      };
    }

    // Normal file (create/update)
    return {
      path: file.path,
      mode: file.mode ?? "100644",
      type: "blob" as const,
      content: file.content,
    };
  });

  // Create tree (GitHub will create blobs from content)
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

  const treeRateLimitInfo = parseRateLimitHeaders(treeResponse);
  logRateLimitWarning(treeRateLimitInfo, context);

  if (!treeResponse.ok) {
    const fileList = files
      .map((f) => `${f.path}${f.content === null ? " (delete)" : ""}`)
      .join(", ");
    await handleApiError(treeResponse, treeRateLimitInfo, context, {
      404: `Base tree not found - baseSha ${baseSha.slice(0, 7)} may be invalid or not accessible`,
      422: `Validation failed creating tree - check file paths, content encoding, or permissions. Files: ${fileList}`,
    });
  }

  const treeData = (await treeResponse.json()) as CreateTreeResponse;

  // Create commit
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

  const commitRateLimitInfo = parseRateLimitHeaders(commitResponse);
  logRateLimitWarning(commitRateLimitInfo, context);

  if (!commitResponse.ok) {
    await handleApiError(commitResponse, commitRateLimitInfo, context, {
      404: `Parent commit ${baseSha.slice(0, 7)} not found - commit may have been deleted or is not accessible`,
      422: `Validation failed creating commit - check commit message format, tree SHA ${treeData.sha.slice(0, 7)}, and parent SHA ${baseSha.slice(0, 7)}`,
    });
  }

  const commitData = (await commitResponse.json()) as CreateCommitResponse;

  // Update branch ref
  const updateRefResponse = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        sha: commitData.sha,
        force, // Allow non-fast-forward updates if force=true
      }),
    }
  );

  const refRateLimitInfo = parseRateLimitHeaders(updateRefResponse);
  logRateLimitWarning(refRateLimitInfo, context);

  if (!updateRefResponse.ok) {
    await handleApiError(updateRefResponse, refRateLimitInfo, context, {
      404: "Branch not found",
      422: force
        ? "Validation failed - commit may already be on branch"
        : "Validation failed - update is not a fast-forward (branch has moved). Use force=true to override or update baseSha.",
    });
  }

  console.log(
    `[github] ${context}: Pushed commit ${commitData.sha.slice(0, 7)} to ${owner}/${repo}:${branch}`
  );

  return {
    sha: commitData.sha,
    url: `https://github.com/${owner}/${repo}/commit/${commitData.sha}`,
  };
};

/**
 * Push a heal's patch to a PR branch.
 */
export interface PushHealOptions {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  filesChanged: Array<{ path: string; content: string | null }>; // null = deleted
  commitMessage: string;
  force?: boolean;
  verifyBaseSha?: boolean;
}

export const pushHealCommit = (
  options: PushHealOptions
): Promise<CommitPushResult> => {
  const {
    token,
    owner,
    repo,
    branch,
    baseSha,
    filesChanged,
    commitMessage,
    force,
    verifyBaseSha,
  } = options;

  // Use the pre-computed file contents from the executor
  const files: FileChange[] = filesChanged.map((f) => ({
    path: f.path,
    content: f.content, // Can be null for deletions
  }));

  return pushCommit(token, {
    owner,
    repo,
    branch,
    baseSha,
    message: commitMessage,
    files,
    force,
    verifyBaseSha,
  });
};

/**
 * Get the current commit SHA for a branch.
 * Useful when you need the base SHA before pushing a commit.
 */
export const getBranchHead = async (
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<string> => {
  const context = `getBranchHead(${owner}/${repo}:${branch})`;

  validateOwnerRepo(owner, repo, context);

  if (!isValidBranchName(branch)) {
    throw new Error(`${context}: Invalid branch name`);
  }

  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`,
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
      404: "Branch not found",
    });
  }

  const refData = (await response.json()) as RefResponse;

  console.log(
    `[github] ${context}: Branch head is ${refData.object.sha.slice(0, 7)}`
  );

  return refData.object.sha;
};
