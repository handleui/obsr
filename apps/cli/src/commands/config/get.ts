import { findGitRoot } from "@detent/git";
import { defineCommand } from "citty";
import { loadConfig } from "../../lib/config.js";
import {
  formatPreferenceValue,
  getPreference,
  isPreferenceKey,
  PREFERENCE_KEYS,
} from "../../lib/preferences.js";
import { CONFIG_KEYS, isConfigKey } from "./constants.js";

// All valid keys (config + preferences)
const ALL_KEYS = [...CONFIG_KEYS, ...PREFERENCE_KEYS] as const;

export const configGetCommand = defineCommand({
  meta: {
    name: "get",
    description: "Get a configuration value",
  },
  args: {
    key: {
      type: "positional",
      description: `Configuration key (${ALL_KEYS.join(", ")})`,
      required: true,
    },
  },
  run: async ({ args }) => {
    const key = args.key;

    // Handle global preferences
    if (isPreferenceKey(key)) {
      try {
        const value = getPreference(key);
        console.log(formatPreferenceValue(key, value));
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : "unknown error"}`
        );
        process.exit(1);
      }
      return;
    }

    // Handle per-repo config
    if (!isConfigKey(key)) {
      console.error(`Unknown key: ${key}`);
      console.error(`Valid keys: ${ALL_KEYS.join(", ")}`);
      process.exit(1);
    }

    // Prevent exposing API key via CLI - use maskApiKey for safe display
    if (key === "apiKey") {
      console.error(
        "Error: API key cannot be retrieved via CLI for security reasons."
      );
      console.error("Use 'detent config list' to see a masked version.");
      process.exit(1);
    }

    try {
      const repoRoot = await findGitRoot(process.cwd());
      if (!repoRoot) {
        console.error("Error: Not in a git repository.");
        process.exit(1);
      }
      const config = loadConfig(repoRoot);
      const value = config[key];

      if (value === undefined || value === null) {
        console.log("");
      } else {
        console.log(value);
      }
    } catch (error) {
      console.error(
        `Error loading config: ${error instanceof Error ? error.message : "unknown error"}`
      );
      process.exit(1);
    }
  },
});
