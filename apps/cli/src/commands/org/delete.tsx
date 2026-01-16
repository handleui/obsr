/**
 * Organization delete command
 *
 * Interactive TUI selector to delete an organization from Detent.
 */

import { defineCommand } from "citty";
import { render, Text } from "ink";
import {
  deleteOrganization,
  getOrganizations,
  type Organization,
} from "../../lib/api.js";
import { getAccessToken } from "../../lib/auth.js";
import { openBrowser } from "../../lib/browser.js";
import { findOrganizationByIdOrSlug } from "../../lib/ui.js";
import { OrgActionFlow, printHeader } from "../../tui/components/index.js";
import { colors } from "../../tui/styles.js";

const runOrgActionFlow = async (
  organizations: Organization[],
  options: {
    initialOrganization?: Organization | null;
    confirm: boolean;
    onSelect?: (org: Organization) => void | Promise<void>;
  }
): Promise<Organization | null> => {
  let result: Organization | null = null;
  const { waitUntilExit } = render(
    <OrgActionFlow
      confirm={options.confirm}
      confirmBody={(org) => {
        const githubUrl = buildGitHubAppUrl(
          org.github_org,
          org.provider_account_type
        );
        return (
          <>
            <Text>This removes all Detent data for this organization.</Text>
            <Text>
              Uninstall the GitHub App at:{" "}
              <Text color={colors.muted}>{githubUrl}</Text>
            </Text>
            <Text> </Text>
          </>
        );
      }}
      confirmHint="Press y to delete, n to cancel."
      confirmTitle={(org) => `Delete ${org.organization_slug}?`}
      initialOrganization={options.initialOrganization}
      onResult={(org) => {
        result = org;
      }}
      onSelect={options.onSelect}
      organizations={organizations}
    />
  );
  await waitUntilExit();
  return result;
};

const buildGitHubAppUrl = (
  login: string,
  accountType: "organization" | "user"
): string => {
  if (accountType === "user") {
    return "https://github.com/settings/installations";
  }
  return `https://github.com/organizations/${login}/settings/installations`;
};

const handleDeleteError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("403") || message.includes("Insufficient")) {
    console.error("Cannot delete: you are not the owner.");
  } else if (message.includes("404") || message.includes("not found")) {
    console.error("Organization not found or already deleted.");
  } else {
    console.error("Failed to delete organization:", message);
  }
  process.exit(1);
};

export const deleteCommand = defineCommand({
  meta: {
    name: "delete",
    description: "Delete an organization from Detent",
  },
  args: {
    organization: {
      type: "positional",
      description: "Organization slug (optional)",
      required: false,
    },
    force: {
      type: "boolean",
      description: "Skip confirmation prompt",
      alias: "f",
      default: false,
    },
  },
  run: async ({ args }) => {
    let accessToken: string;
    try {
      accessToken = await getAccessToken();
    } catch {
      console.error("Not logged in. Run `dt auth login` first.");
      process.exit(1);
    }

    printHeader();

    const { organizations } = await getOrganizations(accessToken).catch(
      (error: unknown) => {
        console.error(
          "Failed to fetch organizations:",
          error instanceof Error ? error.message : error
        );
        process.exit(1);
      }
    );

    // Filter to orgs where user is owner - check upfront before showing UI
    const ownedOrgs = organizations.filter((o) => o.role === "owner");

    if (ownedOrgs.length === 0) {
      console.log("You don't own any organizations.");
      process.exit(0);
    }

    let selectedOrg: Organization;
    let usedInteractiveFlow = false;

    if (args.organization) {
      const found = findOrganizationByIdOrSlug(ownedOrgs, args.organization);
      if (!found) {
        console.error(
          `Organization not found or you are not the owner: ${args.organization}`
        );
        process.exit(1);
      }
      if (args.force) {
        selectedOrg = found;
      } else {
        usedInteractiveFlow = true;
        const selected = await runOrgActionFlow([found], {
          confirm: true,
          initialOrganization: found,
          onSelect: async (org) => {
            const url = buildGitHubAppUrl(
              org.github_org,
              org.provider_account_type
            );
            try {
              await openBrowser(url);
            } catch {
              // Ignore browser open errors
            }
          },
        });
        if (!selected) {
          process.exit(0);
        }
        selectedOrg = selected;
      }
    } else {
      usedInteractiveFlow = true;
      const selected = await runOrgActionFlow(ownedOrgs, {
        confirm: !args.force,
        onSelect: async (org) => {
          const url = buildGitHubAppUrl(
            org.github_org,
            org.provider_account_type
          );
          try {
            await openBrowser(url);
          } catch {
            // Ignore browser open errors
          }
        },
      });
      if (!selected) {
        process.exit(0);
      }
      selectedOrg = selected;
    }

    const githubUrl = buildGitHubAppUrl(
      selectedOrg.github_org,
      selectedOrg.provider_account_type
    );

    if (args.force && !usedInteractiveFlow) {
      try {
        await openBrowser(githubUrl);
      } catch {
        // Ignore browser open errors
      }
      // With --force, skip the confirmation question and proceed directly
    }

    try {
      await deleteOrganization(accessToken, selectedOrg.organization_id);
      console.log(`Deleted ${selectedOrg.organization_slug}`);
    } catch (error) {
      handleDeleteError(error);
    }
  },
});
