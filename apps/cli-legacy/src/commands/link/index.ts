/**
 * Link command - links a repository to a Detent project
 *
 * Detent mirrors GitHub's repository structure. Linking only succeeds when
 * the project is registered in Detent (via GitHub App installation).
 */

import { findGitRoot, getRemoteUrl } from "@detent/git";
import { defineCommand } from "citty";
import { lookupProject } from "../../lib/api.js";
import { getAccessToken } from "../../lib/auth.js";
import { getProjectConfig, saveProjectConfig } from "../../lib/config.js";
import { parseRemoteUrl } from "../../lib/git-utils.js";
import { printHeader } from "../../tui/components/index.js";
import { printOrgProjectTable } from "../../tui/styles.js";

interface LinkResult {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  projectHandle: string;
  repoFullName: string;
}

/**
 * Parse owner from repo full name (e.g., "detentsh" from "detentsh/detent")
 */
const parseOwner = (repoFullName: string): string | null => {
  const parts = repoFullName.split("/");
  return parts[0] || null;
};

/**
 * Link repository to a Detent project.
 *
 * Strategy:
 * 1. Get git remote URL and parse to owner/repo format
 * 2. Lookup project in Detent via API
 * 3. If project exists, return its details
 * 4. If not, fail with clear error
 */
const attemptLink = async (
  repoRoot: string,
  accessToken: string
): Promise<LinkResult> => {
  // Step 1: Get and parse git remote
  const remoteUrl = await getRemoteUrl(repoRoot);
  if (!remoteUrl) {
    console.error("No git remote 'origin' found.");
    console.error("Add a remote with: git remote add origin <url>");
    process.exit(1);
  }

  const repoFullName = parseRemoteUrl(remoteUrl);
  if (!repoFullName) {
    console.error(`Could not parse git remote URL: ${remoteUrl}`);
    console.error(
      "Expected format: git@github.com:owner/repo.git or https://github.com/owner/repo.git"
    );
    process.exit(1);
  }

  const owner = parseOwner(repoFullName);
  if (!owner) {
    console.error(`Could not parse owner from: ${repoFullName}`);
    process.exit(1);
  }

  // Step 2: Lookup project in Detent
  try {
    const project = await lookupProject(accessToken, repoFullName);
    return {
      organizationId: project.organization_id,
      organizationSlug: project.organization_slug,
      organizationName: project.organization_name ?? project.organization_slug,
      projectId: project.project_id,
      projectHandle: project.handle,
      repoFullName,
    };
  } catch {
    // Project not found - fail with helpful error
    console.error("\nCould not link repository.");
    console.error(`\nProject '${repoFullName}' is not registered in Detent.`);
    console.error("\nThis can happen if:");
    console.error(
      `  1. The Detent GitHub App is not installed on '${owner}', or`
    );
    console.error("  2. This repository was added after the app was installed");
    console.error(
      "\nTo fix: Add this repository to the Detent GitHub App installation."
    );
    process.exit(1);
  }
};

export const linkCommand = defineCommand({
  meta: {
    name: "link",
    description: "Link this repository to a Detent project",
  },
  subCommands: {
    status: () => import("./status.js").then((m) => m.statusCommand),
    unlink: () => import("./unlink.js").then((m) => m.unlinkCommand),
  },
  args: {
    force: {
      type: "boolean",
      description: "Overwrite existing link without prompting",
      alias: "f",
      default: false,
    },
  },
  run: async ({ args, rawArgs }) => {
    // Skip if a subcommand is being invoked (check only first positional arg)
    const subcommands = ["status", "unlink"];
    const firstPositionalArg = rawArgs?.find((arg) => !arg.startsWith("-"));
    if (firstPositionalArg && subcommands.includes(firstPositionalArg)) {
      return;
    }

    const repoRoot = await findGitRoot(process.cwd());
    if (!repoRoot) {
      console.error("Not in a git repository.");
      process.exit(1);
    }

    printHeader();

    let accessToken: string;
    try {
      accessToken = await getAccessToken();
    } catch {
      console.error("Not logged in. Run `dt auth login` first.");
      process.exit(1);
    }

    const existingConfig = getProjectConfig(repoRoot);
    if (existingConfig && !args.force) {
      printOrgProjectTable(
        existingConfig.organizationSlug,
        existingConfig.projectHandle
      );
      console.log("");
      console.log("Already linked. Run `dt link --force` to relink.");
      return;
    }

    const result = await attemptLink(repoRoot, accessToken);

    saveProjectConfig(repoRoot, {
      organizationId: result.organizationId,
      organizationSlug: result.organizationSlug,
      projectId: result.projectId,
      projectHandle: result.projectHandle,
    });

    printOrgProjectTable(result.organizationSlug, result.projectHandle);
    console.log("");
    console.log("Linked successfully.");
  },
});
