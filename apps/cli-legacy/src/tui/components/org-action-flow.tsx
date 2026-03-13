import { Box, Text, useApp, useInput } from "ink";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { Organization } from "../../lib/api.js";
import { colors } from "../styles.js";

interface OrgActionFlowProps {
  organizations: Organization[];
  confirm: boolean;
  confirmTitle: (org: Organization) => string;
  confirmBody?: (org: Organization) => ReactNode;
  confirmHint?: string;
  initialOrganization?: Organization | null;
  onSelect?: (org: Organization) => void | Promise<void>;
  onResult: (org: Organization | null) => void;
}

export const OrgActionFlow = ({
  organizations,
  confirm,
  confirmTitle,
  confirmBody,
  confirmHint = "Press y to confirm, n to cancel.",
  initialOrganization = null,
  onSelect,
  onResult,
}: OrgActionFlowProps): JSX.Element => {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(
    initialOrganization
  );
  const [step, setStep] = useState<"select" | "confirm">(
    confirm && initialOrganization ? "confirm" : "select"
  );
  const hasExited = useRef(false);
  const hasNotifiedSelect = useRef(false);

  const handleExit = (org: Organization | null): void => {
    if (hasExited.current) {
      return;
    }
    hasExited.current = true;
    onResult(org);
    exit();
  };

  useEffect(() => {
    if (!(onSelect && selectedOrg) || step !== "confirm") {
      return;
    }
    if (hasNotifiedSelect.current) {
      return;
    }
    hasNotifiedSelect.current = true;
    Promise.resolve(onSelect(selectedOrg)).catch(() => {
      // Ignore onSelect errors
    });
  }, [onSelect, selectedOrg, step]);

  const handleReturn = (): void => {
    const org = organizations[selectedIndex];
    if (!org) {
      return;
    }
    if (confirm) {
      setSelectedOrg(org);
      setStep("confirm");
      return;
    }
    if (onSelect && !hasNotifiedSelect.current) {
      hasNotifiedSelect.current = true;
      Promise.resolve(onSelect(org)).catch(() => {
        // Ignore onSelect errors
      });
    }
    handleExit(org);
  };

  const handleSelectInput = (
    input: string,
    key: Record<string, boolean>
  ): void => {
    const lower = input.toLowerCase();
    if (key.upArrow || lower === "k") {
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (key.downArrow || lower === "j") {
      setSelectedIndex((index) =>
        Math.min(organizations.length - 1, index + 1)
      );
    } else if (key.return) {
      handleReturn();
    } else if (key.escape || lower === "q") {
      handleExit(null);
    }
  };

  useInput((input, key) => {
    const lower = input.toLowerCase();
    if (step === "select") {
      handleSelectInput(input, key);
      return;
    }

    if (lower === "y") {
      handleExit(selectedOrg ?? null);
    } else if (lower === "n" || lower === "q" || key.escape || key.return) {
      handleExit(null);
    }
  });

  return (
    <Box flexDirection="column">
      {step === "select" ? (
        <>
          <Text color={colors.muted}>Select organization (esc to cancel)</Text>
          <Text> </Text>
          {organizations.map((org, index) => {
            const isSelected = index === selectedIndex;
            return (
              <Text
                color={isSelected ? colors.error : undefined}
                key={org.organization_id}
              >
                {isSelected ? "> " : "  "}
                {org.organization_slug}
              </Text>
            );
          })}
        </>
      ) : (
        <>
          <Text color={colors.error}>
            {selectedOrg ? confirmTitle(selectedOrg) : "Continue?"}
          </Text>
          <Text> </Text>
          {selectedOrg && confirmBody ? confirmBody(selectedOrg) : null}
          <Text color={colors.muted}>{confirmHint}</Text>
        </>
      )}
    </Box>
  );
};
