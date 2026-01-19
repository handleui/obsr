import type { Database } from "../db/client";
import { createHeal } from "../db/operations/heals";
import type { Env } from "../types/env";
import { canRunHeal } from "./billing";

interface RequestHealOptions {
  db: Database;
  env: Env;
  projectId: string;
  organizationId: string;
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
}

export const healerService = {
  async requestHeal(options: RequestHealOptions): Promise<RequestHealResult> {
    const billingCheck = await canRunHeal(options.env, options.organizationId);
    if (!billingCheck.allowed) {
      return {
        success: false,
        error: billingCheck.reason,
        code: "BILLING_REQUIRED",
      };
    }

    try {
      const healId = await createHeal(options.db, {
        type: "heal",
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
