import type { CheckSuitePayload, WebhookContext } from "../types";

// Check run creation disabled - heals are now triggered from dashboard only
// Check run will be created when user triggers heal, not automatically on PR
// biome-ignore lint/suspicious/useAwait: async required for webhook handler type signature
export const handleCheckSuiteRequested = async (
  c: WebhookContext,
  payload: CheckSuitePayload
) => {
  const { action, check_suite, repository } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  if (action !== "requested") {
    return c.json({ message: "ignored", action });
  }

  console.log(
    `[check_suite] Skipped automatic check run for ${repository.full_name} @ ${check_suite.head_sha.slice(0, 7)} [delivery: ${deliveryId}]`
  );

  return c.json({
    message: "skipped",
    reason: "automatic_check_runs_disabled",
  });
};
