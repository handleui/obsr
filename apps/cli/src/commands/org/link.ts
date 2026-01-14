/**
 * Organization link command
 *
 * Opens the GitHub App installation page to link a GitHub organization to Detent.
 * Polls the API to detect when the installation completes and confirms success.
 */

import { defineCommand } from "citty";
import { getOrganizations, listProjects, syncIdentity } from "../../lib/api.js";
import { getAccessToken, getGitHubToken } from "../../lib/auth.js";
import { openBrowser } from "../../lib/browser.js";

const GITHUB_APP_INSTALL_URL =
  "https://github.com/apps/detentsh/installations/select_target";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const linkCommand = defineCommand({
  meta: {
    name: "link",
    description: "Link a GitHub organization to Detent",
  },
  run: async () => {
    // Require authentication to poll for new orgs
    let accessToken: string;
    try {
      accessToken = await getAccessToken();
    } catch {
      console.error("Not logged in. Run `dt auth login` first.");
      process.exit(1);
    }

    // Get GitHub token for installer linking (uses OAuth token directly)
    const githubToken = await getGitHubToken();

    // Sync identity and record existing orgs before opening browser
    await syncIdentity(accessToken, githubToken).catch(() => {
      // Ignore sync errors
    });
    const before = await getOrganizations(accessToken);
    const existingOrgIds = new Set(
      before.organizations.map((o) => o.organization_id)
    );

    // Open browser to GitHub App install page
    console.log("Opening GitHub to link an organization to Detent...\n");

    try {
      await openBrowser(GITHUB_APP_INSTALL_URL);
    } catch (error) {
      console.error(
        "Failed to open browser:",
        error instanceof Error ? error.message : error
      );
      console.log("\nPlease open this URL in your browser:");
      console.log(`  ${GITHUB_APP_INSTALL_URL}\n`);
    }

    // Poll for new organization
    console.log("Waiting for installation... (Ctrl+C to cancel)\n");

    const startTime = Date.now();

    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);

      // Sync identity to link installer to new orgs (passes GitHub token for ID lookup)
      await syncIdentity(accessToken, githubToken).catch(() => {
        // Ignore sync errors
      });

      // Check for new organizations
      const after = await getOrganizations(accessToken).catch(() => ({
        organizations: [],
      }));

      const newOrgs = after.organizations.filter(
        (o) => !existingOrgIds.has(o.organization_id)
      );

      const org = newOrgs[0];
      if (org) {
        // Fetch project count for the new org
        let projectCount = 0;
        try {
          const projects = await listProjects(accessToken, org.organization_id);
          projectCount = projects.projects.length;
        } catch {
          // Ignore project fetch errors
        }

        const projectText =
          projectCount === 1 ? "1 repository" : `${projectCount} repositories`;

        console.log(`✓ Linked: ${org.organization_name} (${projectText})`);
        return;
      }
    }

    // Timeout reached
    console.log("No new organization detected.");
    console.log("Run 'dt org list' to check status.");
  },
});
