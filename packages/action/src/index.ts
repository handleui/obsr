// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as core from "@actions/core";

import { collect } from "./collect";
import { report } from "./report";

const run = async (): Promise<void> => {
  try {
    const token = core.getInput("token", { required: true });
    const apiUrl = core.getInput("api-url") || "https://backend.detent.sh";

    core.info("Collecting workflow context...");
    const payload = collect();

    core.info(`Reporting to ${apiUrl}...`);
    const result = await report(payload, token, apiUrl);

    core.info(`Stored ${result.stored} items, run ID: ${result.runId}`);
    core.setOutput("stored", result.stored);
    core.setOutput("run-id", result.runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
};

run();
