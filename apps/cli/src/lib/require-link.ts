/**
 * Project link requirement helper
 *
 * Use this at the start of any command that operates on project-scoped data.
 * Ensures the repository is linked before proceeding.
 *
 * @example
 * // In a command handler (exits on error):
 * const { repoRoot, config } = await requireProjectLink();
 *
 * @example
 * // For testable code, use getProjectLink instead:
 * const result = await getProjectLink();
 * if (!result.ok) {
 *   // Handle error without exiting
 *   printLinkError(result.error);
 *   return;
 * }
 * const { repoRoot, config } = result.value;
 */

import { findGitRoot } from "@detent/git";
import { ANSI_RESET, colors, hexToAnsi } from "../tui/styles.js";
import { getProjectConfigSafe, type ProjectConfig } from "./config.js";

// ============================================================================
// Types
// ============================================================================

export interface LinkedProject {
  repoRoot: string;
  config: ProjectConfig;
}

export type ProjectLinkErrorCode =
  | "not_git_repo"
  | "config_error"
  | "not_linked";

export interface ProjectLinkError {
  code: ProjectLinkErrorCode;
  message: string;
  hint?: string;
}

export type ProjectLinkResult =
  | { ok: true; value: LinkedProject }
  | { ok: false; error: ProjectLinkError };

// ============================================================================
// Helpers
// ============================================================================

const errorPrefix = `${hexToAnsi(colors.error)}error:${ANSI_RESET}`;

// ============================================================================
// Public API
// ============================================================================

/**
 * Gets project link status without exiting.
 * Returns a result type for flexible error handling and testability.
 */
export const getProjectLink = async (): Promise<ProjectLinkResult> => {
  const repoRoot = await findGitRoot(process.cwd());
  if (!repoRoot) {
    return {
      ok: false,
      error: {
        code: "not_git_repo",
        message: "Not in a git repository.",
      },
    };
  }

  const { config, error } = getProjectConfigSafe(repoRoot);
  if (error) {
    return {
      ok: false,
      error: {
        code: "config_error",
        message: error,
      },
    };
  }

  if (!config) {
    return {
      ok: false,
      error: {
        code: "not_linked",
        message: "This repository is not linked to Detent.",
        hint: "Run `dt link` to connect this repository.",
      },
    };
  }

  return { ok: true, value: { repoRoot, config } };
};

/**
 * Prints a ProjectLinkError to stderr with styled error prefix.
 */
export const printLinkError = (error: ProjectLinkError): void => {
  console.error(`${errorPrefix} ${error.message}`);
  if (error.hint) {
    console.error(error.hint);
  }
};

/**
 * Requires project to be linked. Exits with error if not.
 * Use this at the start of any command that operates on project-scoped data.
 *
 * For testable code or custom error handling, use getProjectLink() instead.
 */
export const requireProjectLink = async (): Promise<LinkedProject> => {
  const result = await getProjectLink();

  if (!result.ok) {
    printLinkError(result.error);
    process.exit(1);
  }

  return result.value;
};

/**
 * Requires current directory to be in a git repository. Exits with error if not.
 * Use this for commands that need a git repo but don't require a linked project.
 *
 * @returns The git repository root path
 */
export const requireGitRepo = async (): Promise<string> => {
  const repoRoot = await findGitRoot(process.cwd());
  if (!repoRoot) {
    console.error(`${errorPrefix} Not in a git repository.`);
    process.exit(1);
  }
  return repoRoot;
};
