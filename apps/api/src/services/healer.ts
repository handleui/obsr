import type { HealCreateStatus } from "@detent/types";
import { createHeal } from "../db/operations/heals";
import type { OrganizationSettings } from "../lib/org-settings";
import type { Env } from "../types/env";
import { canRunHeal } from "./billing";

interface RequestHealOptions {
  env: Env;
  projectId: string;
  organizationId: string;
  orgSettings: Required<OrganizationSettings>;
  enforceBilling?: boolean;
  runId?: string;
  commitSha?: string;
  prNumber?: number;
  errorIds?: string[];
  signatureIds?: string[];
}

interface RequestHealResult {
  success: boolean;
  healId?: string;
  error?: string;
  code?: "BILLING_REQUIRED" | "INSERT_FAILED";
  status?: HealCreateStatus;
}

export const healerService = {
  async requestHeal(options: RequestHealOptions): Promise<RequestHealResult> {
    try {
      const requireBillingCheck = options.enforceBilling ?? true;
      if (requireBillingCheck) {
        const billingCheck = await canRunHeal(
          options.env,
          options.organizationId
        );
        if (!billingCheck.allowed) {
          return {
            success: false,
            error: billingCheck.reason ?? "Billing required",
            code: "BILLING_REQUIRED",
          };
        }
      }

      const status = options.orgSettings.healAutoTrigger ? "pending" : "found";
      const healId = await createHeal(options.env, {
        type: "heal",
        status,
        projectId: options.projectId,
        runId: options.runId,
        commitSha: options.commitSha,
        prNumber: options.prNumber,
        errorIds: options.errorIds,
        signatureIds: options.signatureIds,
      });

      return {
        success: true,
        healId,
        status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[healer] Failed to create heal record: ${message}`);
      return {
        success: false,
        error: message,
        code: "INSERT_FAILED",
      };
    }
  },
};
