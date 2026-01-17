/**
 * Organization list command
 */

import { defineCommand } from "citty";
import { getOrganizations, syncUser } from "../../lib/api.js";
import { getAccessToken, getGitHubToken } from "../../lib/auth.js";
import { printHeader } from "../../tui/components/index.js";
import { ANSI_RESET, colors, hexToAnsi } from "../../tui/styles.js";

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List organizations",
  },
  run: async () => {
    let accessToken: string;
    try {
      accessToken = await getAccessToken();
    } catch {
      console.error("Not logged in. Run `dt auth login` first.");
      process.exit(1);
    }

    printHeader();
    console.log();

    const githubToken = await getGitHubToken();
    await syncUser(accessToken, githubToken).catch(() => undefined);

    try {
      const response = await getOrganizations(accessToken);
      const mutedAnsi = hexToAnsi(colors.muted);
      console.log(`${mutedAnsi}slug${ANSI_RESET}`);
      for (const organization of response.organizations) {
        console.log(organization.organization_slug);
      }
    } catch (error) {
      console.error(
        "Failed to fetch organizations:",
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  },
});
