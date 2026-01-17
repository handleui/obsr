import type { ExtractedError } from "@detent/types";
import type { Env } from "../types/env";
import { canRunHeal } from "./billing";

interface HealOptions {
  env: Env;
  orgId: string;
  errors: ExtractedError[];
  repoUrl: string;
  branch: string;
  byok?: boolean;
  runId?: string;
}

interface HealEvent {
  type: "status" | "tool_call" | "message" | "patch" | "complete" | "error";
  data: unknown;
}

export const healerService = {
  async *heal(options: HealOptions): AsyncGenerator<HealEvent> {
    // Check billing before running
    const billingCheck = await canRunHeal(options.env, options.orgId);
    if (!billingCheck.allowed) {
      yield {
        type: "error",
        data: { code: "BILLING_REQUIRED", reason: billingCheck.reason },
      };
      return;
    }

    yield {
      type: "status",
      data: { phase: "initializing" },
    };

    // Stub implementation - healing will be wired up when the API is ready.
    // The actual healing will:
    // 1. Clone repo to workspace
    // 2. Initialize HealLoop with tools from @detent/healing
    // 3. Stream Claude responses
    // 4. Apply patches and verify fixes
    // 5. Record usage via recordAIUsage(env, orgId, runId, healResult, byok)

    yield {
      type: "status",
      data: { phase: "stub", message: "Healing not yet implemented" },
    };

    // When actual healing is implemented, record usage:
    // const healResult = await healLoop.run();
    // await recordAIUsage(options.env, options.orgId, options.runId, {
    //   model: healResult.model,
    //   inputTokens: healResult.inputTokens,
    //   outputTokens: healResult.outputTokens,
    //   cacheCreationInputTokens: healResult.cacheCreationInputTokens,
    //   cacheReadInputTokens: healResult.cacheReadInputTokens,
    //   costUSD: healResult.costUSD,
    // }, options.byok ?? false);

    yield {
      type: "complete",
      data: { success: false, reason: "stub" },
    };
  },
};
