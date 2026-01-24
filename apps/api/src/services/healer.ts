import type { Database } from "../db/client";
import { createHeal } from "../db/operations/heals";
import type { OrganizationSettings } from "../db/schema";
import type { Env } from "../types/env";

interface RequestHealOptions {
  db: Database;
  env: Env;
  projectId: string;
  organizationId: string;
  orgSettings: Required<OrganizationSettings>;
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
  status?: "found" | "pending";
}

export const healerService = {
  async requestHeal(options: RequestHealOptions): Promise<RequestHealResult> {
    try {
      const status = options.orgSettings.healAutoTrigger ? "pending" : "found";
      const healId = await createHeal(options.db, {
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
