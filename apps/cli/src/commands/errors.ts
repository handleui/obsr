/**
 * Errors command - shows CI errors for a commit
 *
 * Used to view detailed CI errors from the command line.
 * Typically invoked via the link in GitHub PR comments.
 */

import { findGitRoot, getCurrentRefs, getRemoteUrl } from "@detent/git";
import { defineCommand } from "citty";
import type { ErrorInfo, ErrorsResponse } from "../lib/api.js";
import { getErrors } from "../lib/api.js";
import { getAccessToken } from "../lib/auth.js";
import { parseRemoteUrl } from "../lib/git-utils.js";

// Display constants
const MAX_MESSAGE_LENGTH = 80;

interface GroupedErrors {
  [filePath: string]: {
    [category: string]: ErrorInfo[];
  };
}

/**
 * Group errors by file path, then by category
 */
const groupErrors = (errors: ErrorInfo[]): GroupedErrors => {
  const grouped: GroupedErrors = {};

  for (const error of errors) {
    const filePath = error.filePath ?? "(unknown file)";
    const category = error.category ?? "unknown";

    if (!grouped[filePath]) {
      grouped[filePath] = {};
    }
    if (!grouped[filePath][category]) {
      grouped[filePath][category] = [];
    }
    grouped[filePath][category].push(error);
  }

  return grouped;
};

/**
 * Format a single file's errors
 */
const formatFileErrors = (
  filePath: string,
  categories: { [category: string]: ErrorInfo[] }
): string[] => {
  const lines: string[] = [filePath];
  const sortedCategories = Object.keys(categories).sort();

  for (const category of sortedCategories) {
    lines.push(`  ${category}`);

    const categoryErrors = categories[category];
    if (!categoryErrors) {
      continue;
    }
    // Sort by line number
    categoryErrors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));

    for (const error of categoryErrors) {
      const lineNum = error.line ? `:${error.line}` : "";
      // Truncate message if too long
      const message =
        error.message.length > MAX_MESSAGE_LENGTH
          ? `${error.message.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
          : error.message;
      lines.push(`    ${lineNum}  ${message}`);
    }
  }

  lines.push(""); // Empty line after file
  return lines;
};

/**
 * Format errors for human-readable output
 * Modern minimal style: grouped by file, then by type
 */
const formatErrorsHuman = (response: ErrorsResponse): string => {
  const { errors, runs, commit } = response;

  if (errors.length === 0) {
    const passedCount = runs.filter((r) => r.conclusion === "success").length;
    const shortSha = commit?.slice(0, 7) ?? "unknown";
    return `No errors found for commit ${shortSha} (${passedCount} run${passedCount === 1 ? "" : "s"} passed)`;
  }

  const lines: string[] = [];
  const grouped = groupErrors(errors);
  const fileCount = Object.keys(grouped).length;
  const sortedFiles = Object.keys(grouped).sort();

  for (const filePath of sortedFiles) {
    const categories = grouped[filePath];
    if (!categories) {
      continue;
    }
    lines.push(...formatFileErrors(filePath, categories));
  }

  // Summary line
  lines.push(
    `${fileCount} file${fileCount === 1 ? "" : "s"} · ${errors.length} error${errors.length === 1 ? "" : "s"}`
  );

  return lines.join("\n");
};

/**
 * Format errors for JSON output
 */
const formatErrorsJson = (response: ErrorsResponse): string => {
  const grouped = groupErrors(response.errors);

  return JSON.stringify(
    {
      commit: response.commit,
      repository: response.repository,
      totalErrors: response.errors.length,
      runs: response.runs,
      files: grouped,
    },
    null,
    2
  );
};

export const errorsCommand = defineCommand({
  meta: {
    name: "errors",
    description: "Show CI errors for a commit",
  },
  args: {
    commit: {
      type: "string",
      description: "Commit SHA to look up (defaults to HEAD)",
      alias: "c",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  run: async ({ args }) => {
    // Find git root
    const repoRoot = await findGitRoot(process.cwd());
    if (!repoRoot) {
      console.error("Not in a git repository.");
      process.exit(1);
    }

    // Get commit SHA (from args or HEAD)
    let commitSha: string;
    if (args.commit) {
      commitSha = args.commit;
    } else {
      try {
        const refs = await getCurrentRefs(repoRoot);
        commitSha = refs.commitSHA;
      } catch {
        console.error("Failed to get current commit SHA.");
        process.exit(1);
      }
    }

    // Get repository from remote URL
    const remoteUrl = await getRemoteUrl(repoRoot);
    if (!remoteUrl) {
      console.error(
        "No git remote found. This repository must have an origin remote."
      );
      process.exit(1);
    }

    const repository = parseRemoteUrl(remoteUrl);
    if (!repository) {
      console.error(`Failed to parse remote URL: ${remoteUrl}`);
      process.exit(1);
    }

    // Get access token
    let accessToken: string;
    try {
      accessToken = await getAccessToken();
    } catch {
      console.error("Not logged in. Run `dt auth login` first.");
      process.exit(1);
    }

    // Fetch errors from API
    try {
      const response = await getErrors(accessToken, commitSha, repository);

      if (args.json) {
        console.log(formatErrorsJson(response));
      } else {
        console.log(formatErrorsHuman(response));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("No CI runs found")) {
        // Not an error, just no data yet - exit successfully
        const shortSha = commitSha.slice(0, 7);
        console.log(`No CI runs found for commit ${shortSha}`);
        console.log("This commit may not have been processed by Detent yet.");
        process.exit(0);
      } else if (
        message.includes("not found") ||
        message.includes("not linked")
      ) {
        console.error(`Repository ${repository} is not linked to Detent.`);
        console.error(
          "Make sure the Detent GitHub App is installed on this repository."
        );
        process.exit(1);
      } else {
        console.error("Failed to fetch errors:", message);
        process.exit(1);
      }
    }
  },
});
