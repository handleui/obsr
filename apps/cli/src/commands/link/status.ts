/**
 * Link status command - shows current project link
 */

import { findGitRoot } from "@detent/git";
import { defineCommand } from "citty";
import { getProjectConfig } from "../../lib/config.js";
import { printHeader } from "../../tui/components/index.js";
import { printOrgProjectTable } from "../../tui/styles.js";

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show link status for this repository",
  },
  run: async () => {
    const repoRoot = await findGitRoot(process.cwd());
    if (!repoRoot) {
      console.error("Not in a git repository.");
      process.exit(1);
    }

    printHeader();
    console.log();

    const projectConfig = getProjectConfig(repoRoot);
    if (!projectConfig) {
      console.log("This repository is not linked.");
      console.log("Run `dt link` to link it.");
      return;
    }

    printOrgProjectTable(
      projectConfig.organizationSlug,
      projectConfig.projectHandle
    );
  },
});
