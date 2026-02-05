// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as core from "@actions/core";

const cleanup = (): void => {
  try {
    core.debug("Running post-action cleanup...");

    const filesChanged = core.getState("files-changed") || "0";
    const committed = core.getState("committed") || "false";

    if (filesChanged !== "0") {
      core.info(
        `Autofix complete: ${filesChanged} file(s) modified, committed: ${committed}`
      );
    } else {
      core.debug("Autofix complete: no changes made");
    }
  } catch (error) {
    // Post scripts should not fail the workflow
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`Cleanup encountered an issue: ${message}`);
  }
};

cleanup();
