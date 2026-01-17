import { defineCommand } from "citty";
import { printHeader } from "../tui/components/index.js";
import { ANSI_RESET, colors, hexToAnsi } from "../tui/styles.js";
import { forceCheckForUpdate, runUpdate } from "../utils/auto-update.js";
import { getVersion } from "../utils/version.js";

const brandAnsi = hexToAnsi(colors.brand);
const mutedAnsi = hexToAnsi(colors.muted);
const errorAnsi = hexToAnsi(colors.error);

export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Update dt to the latest version",
  },
  run: async () => {
    printHeader();

    const currentVersion = getVersion();

    // Force check (bypass cache) for manual update command
    const { hasUpdate, latestVersion } =
      await forceCheckForUpdate(currentVersion);

    if (!hasUpdate) {
      console.log(
        `${brandAnsi}✓${ANSI_RESET} Already on latest version (v${currentVersion})`
      );
      console.log("");
      return;
    }

    console.log(
      `${mutedAnsi}v${currentVersion}${ANSI_RESET} → ${brandAnsi}${latestVersion}${ANSI_RESET}`
    );
    console.log("");

    const success = await runUpdate();

    console.log("");
    if (success) {
      console.log(`${brandAnsi}✓${ANSI_RESET} Updated successfully`);
    } else {
      console.log(`${errorAnsi}✗${ANSI_RESET} Update failed`);
      process.exit(1);
    }
    console.log("");
  },
});
