/**
 * List pending invitations for an organization
 */

import { defineCommand } from "citty";
import {
  getOrganizations,
  type Invitation,
  listInvitations,
  type Organization,
} from "../../../lib/api.js";
import { getAccessToken } from "../../../lib/auth.js";
import {
  findOrganizationByIdOrSlug,
  selectOrganization,
} from "../../../lib/ui.js";
import { printHeader } from "../../../tui/components/index.js";

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const printInvitationsTable = (invitations: Invitation[]) => {
  if (invitations.length === 0) {
    console.log("No pending invitations.");
    return;
  }

  // Calculate column widths
  const emailWidth = Math.max(5, ...invitations.map((i) => i.email.length));
  const roleWidth = 7;
  const expiresWidth = 12;

  // Print header
  const header = [
    "Email".padEnd(emailWidth),
    "Role".padEnd(roleWidth),
    "Expires".padEnd(expiresWidth),
  ].join("  ");
  console.log(header);
  console.log("-".repeat(header.length));

  // Print rows
  for (const inv of invitations) {
    const row = [
      inv.email.padEnd(emailWidth),
      inv.role.padEnd(roleWidth),
      formatDate(inv.expires_at).padEnd(expiresWidth),
    ].join("  ");
    console.log(row);
  }
};

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List pending invitations",
  },
  args: {
    org: {
      type: "string",
      description: "Organization slug",
      alias: "o",
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

    // Filter to orgs where user is admin or owner
    const adminOrgs = organizations.filter(
      (org) => org.role === "owner" || org.role === "admin"
    );

    if (adminOrgs.length === 0) {
      console.error("You must be an owner or admin to view invitations.");
      process.exit(1);
    }

    let selectedOrg: Organization;

    if (args.org) {
      const found = findOrganizationByIdOrSlug(adminOrgs, args.org);
      if (!found) {
        console.error(`Organization not found or no admin access: ${args.org}`);
        process.exit(1);
      }
      selectedOrg = found;
    } else if (adminOrgs.length === 1 && adminOrgs[0]) {
      selectedOrg = adminOrgs[0];
    } else {
      const selected = await selectOrganization(adminOrgs);
      if (!selected) {
        process.exit(0);
      }
      selectedOrg = selected;
    }

    try {
      const { invitations } = await listInvitations(
        accessToken,
        selectedOrg.organization_id
      );

      console.log(
        `\nPending invitations for ${selectedOrg.organization_slug}:\n`
      );
      printInvitationsTable(invitations);
    } catch (err) {
      console.error(
        "Failed to fetch invitations:",
        err instanceof Error ? err.message : err
      );
      process.exit(1);
    }
  },
});
