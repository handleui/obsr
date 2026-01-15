/**
 * Link command - links a repository to a Detent organization
 *
 * Similar to Vercel's project linking, this binds the current repo
 * to an organization for Detent operations.
 */

import { findGitRoot, getRemoteUrl } from "@detent/git";
import { defineCommand } from "citty";
import type { Organization } from "../../lib/api.js";
import { getOrganizations, lookupProject } from "../../lib/api.js";
import { getAccessToken } from "../../lib/auth.js";
import { getProjectConfig, saveProjectConfig } from "../../lib/config.js";
import { parseRemoteUrl } from "../../lib/git-utils.js";
import {
  findOrganizationByIdOrSlug,
  selectOrganization,
} from "../../lib/ui.js";

interface AutoDetectResult {
  success: true;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  repoFullName: string;
}

/**
 * Attempt to auto-detect organization from git remote URL
 */
const attemptAutoDetect = async (
  repoRoot: string,
  accessToken: string
): Promise<AutoDetectResult | null> => {
  const remoteUrl = await getRemoteUrl(repoRoot);
  if (!remoteUrl) {
    return null;
  }

  const repoFullName = parseRemoteUrl(remoteUrl);
  if (!repoFullName) {
    return null;
  }

  try {
    const project = await lookupProject(accessToken, repoFullName);
    return {
      success: true,
      organizationId: project.organization_id,
      organizationSlug: project.organization_slug,
      organizationName: project.organization_name ?? project.organization_slug,
      repoFullName,
    };
  } catch {
    // Project not found in any organization - expected for unlinked repos
    return null;
  }
};

/**
 * Get organization from user selection or CLI argument
 */
const resolveOrganization = async (
  accessToken: string,
  orgArg: string | undefined,
  autoDetectFailed: boolean
): Promise<Organization | null> => {
  console.log(
    autoDetectFailed
      ? "Could not auto-detect project. Fetching your organizations..."
      : "Fetching your organizations..."
  );

  const response = await getOrganizations(accessToken).catch((error) => {
    console.error(
      "Failed to fetch organizations:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  });

  if (response.organizations.length === 0) {
    console.error("You are not a member of any organizations.");
    console.error(
      "You must be a member of the GitHub organization where Detent is installed."
    );
    process.exit(1);
  }

  if (orgArg) {
    const found = findOrganizationByIdOrSlug(response.organizations, orgArg);
    if (!found) {
      console.error(`Organization not found: ${orgArg}`);
      console.error("\nAvailable organizations:");
      for (const organization of response.organizations) {
        console.error(
          `  - ${organization.organization_slug} (${organization.organization_name})`
        );
      }
      process.exit(1);
    }
    return found;
  }

  return selectOrganization(response.organizations);
};

export const linkCommand = defineCommand({
  meta: {
    name: "link",
    description: "Link this repository to a Detent organization",
  },
  subCommands: {
    status: () => import("./status.js").then((m) => m.statusCommand),
    unlink: () => import("./unlink.js").then((m) => m.unlinkCommand),
  },
  args: {
    organization: {
      type: "string",
      description: "Organization ID or slug to link to",
      alias: "o",
    },
    force: {
      type: "boolean",
      description: "Overwrite existing link without prompting",
      alias: "f",
      default: false,
    },
  },
  run: async ({ args }) => {
    const repoRoot = await findGitRoot(process.cwd());
    if (!repoRoot) {
      console.error("Not in a git repository.");
      process.exit(1);
    }

    let accessToken: string;
    try {
      accessToken = await getAccessToken();
    } catch {
      console.error("Not logged in. Run `dt auth login` first.");
      process.exit(1);
    }

    const existingConfig = getProjectConfig(repoRoot);
    if (existingConfig && !args.force) {
      console.log(
        `\nThis repository is already linked to organization: ${existingConfig.organizationSlug}`
      );
      console.log("Run `dt link --force` to link to a different organization.");
      console.log("Run `dt link status` to see details.");
      return;
    }

    const shouldAttemptAutoDetect = !args.organization;
    if (shouldAttemptAutoDetect) {
      const autoDetected = await attemptAutoDetect(repoRoot, accessToken);
      if (autoDetected) {
        saveProjectConfig(repoRoot, {
          organizationId: autoDetected.organizationId,
          organizationSlug: autoDetected.organizationSlug,
        });
        console.log(
          `\nLinked to organization: ${autoDetected.organizationName} (${autoDetected.organizationSlug})`
        );
        console.log(`Auto-detected from ${autoDetected.repoFullName}.`);
        console.log("\nRun `dt link status` to see details.");
        return;
      }
    }

    const selectedOrganization = await resolveOrganization(
      accessToken,
      args.organization,
      shouldAttemptAutoDetect
    );

    if (!selectedOrganization) {
      process.exit(1);
    }

    saveProjectConfig(repoRoot, {
      organizationId: selectedOrganization.organization_id,
      organizationSlug: selectedOrganization.organization_slug,
    });

    console.log(
      `\nLinked to organization: ${selectedOrganization.organization_name} (${selectedOrganization.organization_slug})`
    );
    console.log("\nRun `dt link status` to see details.");
  },
});
