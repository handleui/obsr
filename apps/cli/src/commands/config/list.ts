import { findGitRoot } from "@detent/git";
import { defineCommand } from "citty";
import {
  formatBudget,
  getRepoConfigPath,
  loadConfig,
  maskApiKey,
} from "../../lib/config.js";
import {
  formatPreferenceValue,
  loadPreferences,
  PREFERENCE_KEYS,
} from "../../lib/preferences.js";
import { printHeader } from "../../tui/components/index.js";

export const configListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all configuration values",
  },
  run: async () => {
    const repoRoot = await findGitRoot(process.cwd());
    if (!repoRoot) {
      console.error("Error: Not in a git repository.");
      process.exit(1);
    }
    const config = loadConfig(repoRoot);
    const prefs = loadPreferences();
    const configPath = getRepoConfigPath(repoRoot);
    const hasEnvApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

    printHeader();

    // Per-repo config
    console.log(`Config file: ${configPath}`);
    console.log();
    const maskedKey = maskApiKey(config.apiKey);
    const apiKeyDisplay = maskedKey || "(not set)";
    const apiKeySource = hasEnvApiKey ? " (from environment)" : "";
    console.log(`apiKey: ${apiKeyDisplay}${apiKeySource}`);
    console.log(`model: ${config.model}`);
    console.log(`budgetPerRunUsd: ${formatBudget(config.budgetPerRunUsd)}`);
    console.log(`budgetMonthlyUsd: ${formatBudget(config.budgetMonthlyUsd)}`);
    console.log(`timeoutMins: ${config.timeoutMins}`);
    console.log();

    // Global preferences
    console.log("Global preferences:");
    for (const key of PREFERENCE_KEYS) {
      const value = prefs[key];
      console.log(`  ${key}: ${formatPreferenceValue(key, value)}`);
    }
    console.log();
  },
});
