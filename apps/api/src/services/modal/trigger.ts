/**
 * Modal Executor Trigger Service
 *
 * Triggers autofix jobs on the Modal executor and handles responses.
 */

import type { Env } from "../../types/env";

interface TriggerAutofixOptions {
  healId: string;
  repoUrl: string;
  commitSha: string;
  branch: string;
  command: string;
  githubToken: string;
}

interface TriggerResult {
  success: boolean;
  error?: string;
}

/**
 * Trigger an autofix job on the Modal executor.
 *
 * The executor will:
 * 1. Clone the repo at the specified commit
 * 2. Run the autofix command
 * 3. Generate a patch
 * 4. POST the result back to our webhook
 */
export const triggerModalAutofix = async (
  env: Env,
  options: TriggerAutofixOptions
): Promise<TriggerResult> => {
  const modalUrl = env.MODAL_EXECUTOR_URL;

  if (!modalUrl) {
    console.log("[modal] MODAL_EXECUTOR_URL not configured, skipping trigger");
    return { success: false, error: "Modal executor not configured" };
  }

  const { healId, repoUrl, commitSha, branch, command, githubToken } = options;

  try {
    const response = await fetch(modalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        heal_id: healId,
        repo_url: repoUrl,
        commit_sha: commitSha,
        branch,
        command,
        github_token: githubToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[modal] Trigger failed: ${response.status} ${errorText.slice(0, 200)}`
      );
      return {
        success: false,
        error: `Modal returned ${response.status}: ${errorText.slice(0, 100)}`,
      };
    }

    const result = (await response.json()) as {
      accepted: boolean;
      error?: string;
    };

    if (!result.accepted) {
      console.error(`[modal] Job rejected: ${result.error}`);
      return { success: false, error: result.error };
    }

    console.log(`[modal] Triggered autofix for heal ${healId}`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[modal] Trigger error: ${message}`);
    return { success: false, error: message };
  }
};

/**
 * Build GitHub repo URL from full repo name.
 * E.g., "owner/repo" -> "https://github.com/owner/repo"
 */
export const buildGitHubRepoUrl = (repoFullName: string): string =>
  `https://github.com/${repoFullName}`;
