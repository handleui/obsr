/**
 * Organization invite command
 *
 * Multi-step TUI to invite a user to an organization.
 * Steps: org selection → email input → role selection → submit
 */

import { Select, Spinner, TextInput } from "@inkjs/ui";
import { defineCommand } from "citty";
import { Box, render, Text, useApp } from "ink";
import { useState } from "react";
import {
  createInvitation,
  getOrganizations,
  type Organization,
} from "../../lib/api.js";
import { getAccessToken } from "../../lib/auth.js";
import { findOrganizationByIdOrSlug } from "../../lib/ui.js";
import { printHeader } from "../../tui/components/index.js";
import { colors } from "../../tui/styles.js";

type Role = "admin" | "member" | "visitor";
type Step = "org" | "email" | "role" | "submitting" | "done" | "error";

// RFC 5322 simplified email pattern (matches API validation)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isValidEmail = (email: string): boolean => {
  const trimmed = email.trim().toLowerCase();
  return (
    trimmed.length > 0 && trimmed.length <= 255 && EMAIL_PATTERN.test(trimmed)
  );
};

interface InviteFlowProps {
  organizations: Organization[];
  initialOrg?: Organization | null;
  initialEmail?: string;
  initialRole?: Role;
  accessToken: string;
  onComplete: (result: InviteResult | null) => void;
}

interface InviteResult {
  email: string;
  role: string;
  expiresAt: string;
  orgSlug: string;
}

const roleOptions = [
  { label: "Member - Standard access", value: "member" as Role },
  { label: "Admin - Full management access", value: "admin" as Role },
  { label: "Visitor - Read-only access", value: "visitor" as Role },
];

const sendInvitationNonInteractive = async (
  accessToken: string,
  org: Organization,
  email: string,
  role: Role
): Promise<void> => {
  if (!isValidEmail(email)) {
    console.error("Invalid email address format");
    process.exit(1);
  }

  try {
    const response = await createInvitation(
      accessToken,
      org.organization_id,
      email.trim().toLowerCase(),
      role
    );
    console.log(`Invitation sent to ${response.email}`);
    console.log(
      `Role: ${response.role} • Expires: ${new Date(response.expires_at).toLocaleDateString()}`
    );
  } catch (err) {
    console.error(
      "Failed to send invitation:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  }
};

const InviteFlow = ({
  organizations,
  initialOrg,
  initialEmail,
  initialRole,
  accessToken,
  onComplete,
}: InviteFlowProps) => {
  const { exit } = useApp();

  // Determine starting step based on which values are pre-provided
  // Note: If all three are provided, the `run` function uses non-interactive mode,
  // so we never reach the component with all values set
  const [step, setStep] = useState<Step>(() => {
    if (!initialOrg) {
      return "org";
    }
    if (!initialEmail) {
      return "email";
    }
    return "role";
  });

  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(
    initialOrg ?? null
  );
  const [email, setEmail] = useState(initialEmail ?? "");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  const orgOptions = organizations.map((org) => ({
    label: org.organization_slug,
    value: org.organization_id,
  }));

  const handleOrgSelect = (orgId: string) => {
    const org = organizations.find((o) => o.organization_id === orgId);
    if (org) {
      setSelectedOrg(org);
      if (initialEmail) {
        if (initialRole) {
          setStep("submitting");
          submitInvitation(org, initialEmail, initialRole);
        } else {
          setStep("role");
        }
      } else {
        setStep("email");
      }
    }
  };

  const handleEmailSubmit = (value: string) => {
    const trimmed = value.trim().toLowerCase();
    if (!isValidEmail(trimmed)) {
      setError("Please enter a valid email address");
      setStep("error");
      exit();
      return;
    }
    setEmail(trimmed);
    if (initialRole && selectedOrg) {
      setStep("submitting");
      submitInvitation(selectedOrg, trimmed, initialRole);
    } else {
      setStep("role");
    }
  };

  const handleRoleSelect = (value: string) => {
    const selectedRole = value as Role;
    if (selectedOrg) {
      setStep("submitting");
      submitInvitation(selectedOrg, email, selectedRole);
    }
  };

  const submitInvitation = async (
    org: Organization,
    inviteEmail: string,
    inviteRole: Role
  ) => {
    try {
      const response = await createInvitation(
        accessToken,
        org.organization_id,
        inviteEmail,
        inviteRole
      );
      const inviteResult: InviteResult = {
        email: response.email,
        role: response.role,
        expiresAt: response.expires_at,
        orgSlug: org.organization_slug,
      };
      setResult(inviteResult);
      setStep("done");
      onComplete(inviteResult);
      exit();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStep("error");
      onComplete(null);
      exit();
    }
  };

  if (step === "submitting") {
    return (
      <Box flexDirection="column">
        <Spinner label="Sending invitation..." />
      </Box>
    );
  }

  if (step === "done" && result) {
    return (
      <Box flexDirection="column">
        <Text color={colors.success}>Invitation sent to {result.email}</Text>
        <Text color={colors.muted}>
          Role: {result.role} • Expires:{" "}
          {new Date(result.expiresAt).toLocaleDateString()}
        </Text>
      </Box>
    );
  }

  if (step === "error") {
    return (
      <Box flexDirection="column">
        <Text color={colors.error}>Failed to send invitation</Text>
        {error && <Text color={colors.muted}>{error}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {step === "org" && (
        <>
          <Text color={colors.muted}>Select organization</Text>
          <Select onChange={handleOrgSelect} options={orgOptions} />
        </>
      )}

      {step === "email" && (
        <>
          <Text color={colors.muted}>
            Inviting to {selectedOrg?.organization_slug}
          </Text>
          <Box>
            <Text>Email: </Text>
            <TextInput
              onSubmit={handleEmailSubmit}
              placeholder="user@example.com"
            />
          </Box>
        </>
      )}

      {step === "role" && (
        <>
          <Text color={colors.muted}>
            Inviting {email} to {selectedOrg?.organization_slug}
          </Text>
          <Text>Select role:</Text>
          <Select onChange={handleRoleSelect} options={roleOptions} />
        </>
      )}
    </Box>
  );
};

export const inviteCommand = defineCommand({
  meta: {
    name: "invite",
    description: "Invite a user to an organization",
  },
  args: {
    email: {
      type: "positional",
      description: "Email address to invite",
      required: false,
    },
    role: {
      type: "string",
      description: "Role to assign (admin, member, visitor)",
      alias: "r",
    },
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

    if (organizations.length === 0) {
      console.log("You are not a member of any organizations.");
      process.exit(0);
    }

    // Filter to orgs where user is admin or owner
    const adminOrgs = organizations.filter(
      (org) => org.role === "owner" || org.role === "admin"
    );

    if (adminOrgs.length === 0) {
      console.error(
        "You must be an owner or admin to invite users to an organization."
      );
      process.exit(1);
    }

    // Resolve initial values from args
    let initialOrg: Organization | null = null;
    if (args.org) {
      const found = findOrganizationByIdOrSlug(adminOrgs, args.org);
      if (!found) {
        console.error(`Organization not found or no admin access: ${args.org}`);
        process.exit(1);
      }
      initialOrg = found;
    } else if (adminOrgs.length === 1 && adminOrgs[0]) {
      initialOrg = adminOrgs[0];
    }

    const initialEmail = args.email as string | undefined;

    // Validate email format early if provided
    if (initialEmail && !isValidEmail(initialEmail)) {
      console.error("Invalid email address format");
      process.exit(1);
    }

    let initialRole: Role | undefined;
    if (args.role) {
      const roleArg = args.role.toLowerCase();
      if (!["admin", "member", "visitor"].includes(roleArg)) {
        console.error("Role must be 'admin', 'member', or 'visitor'");
        process.exit(1);
      }
      initialRole = roleArg as Role;
    }

    // If all values provided, run non-interactively
    if (initialOrg && initialEmail && initialRole) {
      await sendInvitationNonInteractive(
        accessToken,
        initialOrg,
        initialEmail,
        initialRole
      );
      return;
    }

    // Interactive mode
    let inviteResult: InviteResult | null = null;
    const { waitUntilExit } = render(
      <InviteFlow
        accessToken={accessToken}
        initialEmail={initialEmail}
        initialOrg={initialOrg}
        initialRole={initialRole}
        onComplete={(result) => {
          inviteResult = result;
        }}
        organizations={adminOrgs}
      />
    );

    await waitUntilExit();

    if (!inviteResult) {
      process.exit(1);
    }
  },
});
