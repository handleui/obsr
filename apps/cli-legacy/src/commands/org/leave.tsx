/**
 * Organization leave command
 *
 * Interactive TUI selector to leave an organization.
 */

import { defineCommand } from "citty";
import { render } from "ink";
import {
  getOrganizations,
  leaveOrganization,
  type Organization,
} from "../../lib/api.js";
import { getAccessToken } from "../../lib/auth.js";
import { findOrganizationByIdOrSlug } from "../../lib/ui.js";
import { OrgActionFlow, printHeader } from "../../tui/components/index.js";

const runOrgActionFlow = async (
  organizations: Organization[],
  options: {
    initialOrganization?: Organization | null;
    confirm: boolean;
  }
): Promise<Organization | null> => {
  let result: Organization | null = null;
  const { waitUntilExit } = render(
    <OrgActionFlow
      confirm={options.confirm}
      confirmHint="Press y to leave, n to cancel."
      confirmTitle={(org) => `Leave ${org.organization_slug}?`}
      initialOrganization={options.initialOrganization}
      onResult={(org) => {
        result = org;
      }}
      organizations={organizations}
    />
  );
  await waitUntilExit();
  return result;
};

const handleLeaveError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("only member") || message.includes("sole_member")) {
    console.error("Cannot leave as the only member.");
    console.error("Use `dt org delete` to remove the organization.");
  } else if (message.includes("only owner")) {
    console.error("Cannot leave: you are the only owner.");
  } else if (message.includes("not a member")) {
    console.error("You are not a member of this organization.");
  } else {
    console.error("Failed to leave organization:", message);
  }
  process.exit(1);
};

export const leaveCommand = defineCommand({
  meta: {
    name: "leave",
    description: "Leave an organization",
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

    if (organizations.length === 0) {
      console.log("You are not a member of any organizations.");
      process.exit(0);
    }

    let selectedOrg: Organization;

    if (args.organization) {
      const found = findOrganizationByIdOrSlug(
        organizations,
        args.organization
      );
      if (!found) {
        console.error(`Organization not found: ${args.organization}`);
        process.exit(1);
      }
      if (args.force) {
        selectedOrg = found;
      } else {
        const selected = await runOrgActionFlow([found], {
          initialOrganization: found,
          confirm: true,
        });
        if (!selected) {
          process.exit(0);
        }
        selectedOrg = selected;
      }
    } else {
      const selected = await runOrgActionFlow(organizations, {
        confirm: !args.force,
      });
      if (!selected) {
        process.exit(0);
      }
      selectedOrg = selected;
    }

    try {
      await leaveOrganization(accessToken, selectedOrg.organization_id);
      console.log(`Left ${selectedOrg.organization_slug}`);
    } catch (error) {
      handleLeaveError(error);
    }
  },
});
