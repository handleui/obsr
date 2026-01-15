/**
 * Organization leave command
 *
 * Leave an organization you are a member of.
 */

import { createInterface } from "node:readline/promises";
import { defineCommand } from "citty";
import {
  getOrganizations,
  leaveOrganization,
  type Organization,
} from "../../lib/api.js";
import { getAccessToken } from "../../lib/auth.js";
import {
  findOrganizationByIdOrSlug,
  selectOrganization,
} from "../../lib/ui.js";
import { printHeader } from "../../tui/components/index.js";

const confirm = async (message: string): Promise<boolean> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${message} (y/N): `);
    return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
  } finally {
    rl.close();
  }
};

const handleLeaveError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("only owner")) {
    console.error("\n✗ Cannot leave organization");
    console.error("You are the only owner. Transfer ownership before leaving.");
  } else if (message.includes("not a member")) {
    console.error("\n✗ You are not a member of this organization");
  } else {
    console.error("\nFailed to leave organization:", message);
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
      description:
        "Organization ID or slug (optional - will prompt if not provided)",
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
    console.log();

    const organizationsResponse = await getOrganizations(accessToken).catch(
      (error: unknown) => {
        console.error(
          "Failed to fetch organizations:",
          error instanceof Error ? error.message : error
        );
        process.exit(1);
      }
    );

    if (organizationsResponse.organizations.length === 0) {
      console.log("You are not a member of any organizations.");
      process.exit(0);
    }

    let selectedOrganization: Organization;

    if (args.organization) {
      const found = findOrganizationByIdOrSlug(
        organizationsResponse.organizations,
        args.organization
      );
      if (!found) {
        console.error(`Organization not found: ${args.organization}`);
        process.exit(1);
      }
      selectedOrganization = found;
    } else {
      const selected = await selectOrganization(
        organizationsResponse.organizations
      );
      if (!selected) {
        process.exit(1);
      }
      selectedOrganization = selected;
    }

    // Confirm unless --force
    if (!args.force) {
      console.log(`Leave "${selectedOrganization.organization_name}"?`);
      if (selectedOrganization.role === "owner") {
        console.log(
          "You are an owner. If you are the only owner, you cannot leave."
        );
      }

      const confirmed = await confirm("Confirm leave");
      if (!confirmed) {
        console.log("Cancelled.");
        process.exit(0);
      }
    }

    try {
      await leaveOrganization(
        accessToken,
        selectedOrganization.organization_id
      );
      console.log(
        `\n✓ Successfully left "${selectedOrganization.organization_name}"`
      );
    } catch (error) {
      handleLeaveError(error);
    }
  },
});
