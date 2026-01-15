/**
 * Organization add command
 *
 * Opens the GitHub App installation page to add a GitHub organization to Detent.
 * Polls the API to detect when the installation completes and confirms success.
 */

import { defineCommand } from "citty";
import { getOrganizations, listProjects, syncIdentity } from "../../lib/api.js";
import { getAccessToken, getGitHubToken } from "../../lib/auth.js";
import { openBrowser } from "../../lib/browser.js";
import { printHeader } from "../../tui/components/index.js";

const GITHUB_APP_INSTALL_URL =
  "https://github.com/apps/detentsh/installations/select_target";

const POLL_INTERVAL_MS = 2000;
const SYNC_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Add a GitHub organization to Detent",
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

    printHeader();

    // Get GitHub token for installer linking (uses OAuth token directly)
    const githubToken = await getGitHubToken();

    // Sync identity and record existing orgs before opening browser
    await syncIdentity(accessToken, githubToken).catch(() => {
      // Ignore sync errors
    });
    let existingOrgIds = new Set<string>();
    try {
      const before = await getOrganizations(accessToken);
      existingOrgIds = new Set(
        before.organizations.map((o) => o.organization_id)
      );
    } catch (error) {
      console.error(
        "Failed to fetch organizations:",
        error instanceof Error ? error.message : String(error)
      );
      console.error("Please try again or run `dt auth login --force`.");
      process.exit(1);
    }

    // Open browser to GitHub App install page
    console.log("Opening GitHub to add an organization to Detent...\n");

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

    let lastSyncAt = Date.now();

    while (Date.now() - startTime < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);

      // Sync identity to link installer to new orgs (passes GitHub token for ID lookup)
      if (Date.now() - lastSyncAt >= SYNC_INTERVAL_MS) {
        await syncIdentity(accessToken, githubToken).catch(() => {
          // Ignore sync errors
        });
        lastSyncAt = Date.now();
      }

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

        console.log(`✓ Added: ${org.organization_name} (${projectText})`);
        return;
      }
    }

    // Timeout reached
    console.log("No new organization detected.");
    console.log("Run 'dt org list' to check status.");
  },
});
