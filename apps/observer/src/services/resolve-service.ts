import type { ResolveCreateStatus } from "@detent/types";
import { createResolve } from "../db/operations/resolves";
import type { OrganizationSettings } from "../lib/org-settings";
import type { Env } from "../types/env";
import { canRunResolve } from "./billing";

interface RequestResolveOptions {
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

interface RequestResolveResult {
  success: boolean;
  resolveId?: string;
  error?: string;
  code?: "BILLING_REQUIRED" | "INSERT_FAILED";
  status?: ResolveCreateStatus;
}

export const resolverService = {
  async requestResolve(
    options: RequestResolveOptions
  ): Promise<RequestResolveResult> {
    try {
      const requireBillingCheck = options.enforceBilling ?? true;
      if (requireBillingCheck) {
        const billingCheck = await canRunResolve(
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

      const status = options.orgSettings.resolveAutoTrigger
        ? "pending"
        : "found";
      const resolveId = await createResolve(options.env, {
        type: "resolve",
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
        resolveId,
        status,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[resolver] Failed to create resolve record: ${message}`);
      return {
        success: false,
        error: message,
        code: "INSERT_FAILED",
      };
    }
  },
};
