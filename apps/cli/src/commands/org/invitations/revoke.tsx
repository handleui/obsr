/**
 * Revoke a pending invitation
 *
 * Interactive TUI to select and revoke an invitation.
 */

import { Select, Spinner } from "@inkjs/ui";
import { defineCommand } from "citty";
import { Box, render, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  getOrganizations,
  type Invitation,
  listInvitations,
  type Organization,
  revokeInvitation,
} from "../../../lib/api.js";
import { getAccessToken } from "../../../lib/auth.js";
import {
  findOrganizationByIdOrSlug,
  selectOrganization,
} from "../../../lib/ui.js";
import { printHeader } from "../../../tui/components/index.js";
import { colors } from "../../../tui/styles.js";

type Step = "select" | "confirm" | "revoking" | "done" | "error";

interface RevokeFlowProps {
  invitations: Invitation[];
  organization: Organization;
  accessToken: string;
  skipConfirm: boolean;
  onComplete: (success: boolean) => void;
}

const RevokeFlow = ({
  invitations,
  organization,
  accessToken,
  skipConfirm,
  onComplete,
}: RevokeFlowProps) => {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("select");
  const [selectedInvitation, setSelectedInvitation] =
    useState<Invitation | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track mounted state to prevent state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const options = invitations.map((inv) => ({
    label: `${inv.email} (${inv.role})`,
    value: inv.id,
  }));

  const handleSelect = (invitationId: string) => {
    const inv = invitations.find((i) => i.id === invitationId);
    if (inv) {
      setSelectedInvitation(inv);
      if (skipConfirm) {
        performRevoke(inv);
      } else {
        setStep("confirm");
      }
    }
  };

  const performRevoke = async (inv: Invitation) => {
    setStep("revoking");
    try {
      await revokeInvitation(accessToken, organization.organization_id, inv.id);
      if (!mountedRef.current) {
        return;
      }
      setStep("done");
      onComplete(true);
      exit();
    } catch (err) {
      if (!mountedRef.current) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setStep("error");
      onComplete(false);
      exit();
    }
  };

  useInput((input, key) => {
    if (step !== "confirm") {
      return;
    }

    const lower = input.toLowerCase();
    if (lower === "y" && selectedInvitation) {
      performRevoke(selectedInvitation);
    } else if (lower === "n" || key.escape) {
      onComplete(false);
      exit();
    }
  });

  if (step === "revoking") {
    return (
      <Box flexDirection="column">
        <Spinner label="Revoking invitation..." />
      </Box>
    );
  }

  if (step === "done") {
    return (
      <Box flexDirection="column">
        <Text color={colors.success}>
          Revoked invitation to {selectedInvitation?.email}
        </Text>
      </Box>
    );
  }

  if (step === "error") {
    return (
      <Box flexDirection="column">
        <Text color={colors.error}>Failed to revoke invitation</Text>
        {error && <Text color={colors.muted}>{error}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {step === "select" && (
        <>
          <Text color={colors.muted}>
            Select invitation to revoke (esc to cancel)
          </Text>
          <Select onChange={handleSelect} options={options} />
        </>
      )}

      {step === "confirm" && selectedInvitation && (
        <>
          <Text color={colors.error}>
            Revoke invitation to {selectedInvitation.email}?
          </Text>
          <Text color={colors.muted}>Press y to confirm, n to cancel.</Text>
        </>
      )}
    </Box>
  );
};

export const revokeCommand = defineCommand({
  meta: {
    name: "revoke",
    description: "Revoke a pending invitation",
  },
  args: {
    org: {
      type: "string",
      description: "Organization slug",
      alias: "o",
    },
    id: {
      type: "string",
      description: "Invitation ID (for scripting)",
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

    // Filter to orgs where user is admin or owner
    const adminOrgs = organizations.filter(
      (org) => org.role === "owner" || org.role === "admin"
    );

    if (adminOrgs.length === 0) {
      console.error("You must be an owner or admin to revoke invitations.");
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

    // If ID provided directly, revoke without interactive selection
    if (args.id) {
      try {
        await revokeInvitation(
          accessToken,
          selectedOrg.organization_id,
          args.id
        );
        console.log("Invitation revoked.");
      } catch (err) {
        console.error(
          "Failed to revoke invitation:",
          err instanceof Error ? err.message : err
        );
        process.exit(1);
      }
      return;
    }

    // Fetch invitations for interactive selection
    const { invitations } = await listInvitations(
      accessToken,
      selectedOrg.organization_id
    ).catch((error: unknown) => {
      console.error(
        "Failed to fetch invitations:",
        error instanceof Error ? error.message : error
      );
      process.exit(1);
    });

    if (invitations.length === 0) {
      console.log("No pending invitations to revoke.");
      process.exit(0);
    }

    let success = false;
    const { waitUntilExit } = render(
      <RevokeFlow
        accessToken={accessToken}
        invitations={invitations}
        onComplete={(result) => {
          success = result;
        }}
        organization={selectedOrg}
        skipConfirm={args.force}
      />
    );

    await waitUntilExit();

    if (!success) {
      process.exit(1);
    }
  },
});
