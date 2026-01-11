import { findGitRoot } from "@detent/git";
import { redactSensitiveData } from "@detent/parser";
import { defineCommand } from "citty";
import {
  ensureRepoDetentDir,
  type GlobalConfig,
  loadRepoConfig,
  saveRepoConfig,
  type ValidationResult,
  validateApiKey,
  validateBudgetMonthly,
  validateBudgetPerRun,
  validateModel,
  validateTimeout,
} from "../../lib/config.js";
import {
  isPreferenceKey,
  PREFERENCE_KEYS,
  type PreferenceKey,
  parsePreferenceValue,
  setPreference,
} from "../../lib/preferences.js";
import { CONFIG_KEYS, type ConfigKey, isConfigKey } from "./constants.js";

// All valid keys (config + preferences)
const ALL_KEYS = [...CONFIG_KEYS, ...PREFERENCE_KEYS] as const;

// Helper to parse and validate string values (apiKey, model)
const parseStringValue = (
  value: string,
  validate: (v: string) => ValidationResult,
  errorFallback: string
): string | undefined => {
  if (value && value.trim() !== "") {
    const result = validate(value);
    if (!result.valid) {
      throw new Error(result.error ?? errorFallback);
    }
  }
  return value || undefined;
};

// Helper to parse and validate numeric values
const parseNumberValue = (
  value: string,
  validate: (v: number) => ValidationResult,
  errorFallback: string
): number => {
  const num = Number(value);
  if (Number.isNaN(num)) {
    throw new Error(`Invalid number: ${value}`);
  }
  const result = validate(num);
  if (!result.valid) {
    throw new Error(result.error ?? errorFallback);
  }
  return num;
};

// Validator map for each config key
const validators: Record<ConfigKey, (value: string) => unknown> = {
  apiKey: (v) => parseStringValue(v, validateApiKey, "Invalid API key format"),
  model: (v) => parseStringValue(v, validateModel, "Invalid model name"),
  budgetPerRunUsd: (v) =>
    parseNumberValue(v, validateBudgetPerRun, "Invalid budget value"),
  budgetMonthlyUsd: (v) =>
    parseNumberValue(v, validateBudgetMonthly, "Invalid monthly budget value"),
  timeoutMins: (v) =>
    parseNumberValue(v, validateTimeout, "Invalid timeout value"),
};

const parseAndValidate = (key: ConfigKey, value: string): unknown => {
  const validator = validators[key];
  return validator(value);
};

export const configSetCommand = defineCommand({
  meta: {
    name: "set",
    description: "Set a configuration value",
  },
  args: {
    key: {
      type: "positional",
      description: `Configuration key (${ALL_KEYS.join(", ")})`,
      required: true,
    },
    value: {
      type: "positional",
      description: "Value to set",
      required: true,
    },
  },
  run: async ({ args }) => {
    const key = args.key;
    const rawValue = args.value;

    // Handle global preferences (autoUpdate, etc.)
    if (isPreferenceKey(key)) {
      try {
        const parsed = parsePreferenceValue(key, rawValue);
        setPreference(key as PreferenceKey, parsed);
        console.log("ok");
      } catch (error) {
        console.error(error instanceof Error ? error.message : "unknown error");
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

    try {
      const repoRoot = await findGitRoot(process.cwd());
      if (!repoRoot) {
        console.error("Error: Not in a git repository.");
        process.exit(1);
      }

      const parsed = parseAndValidate(key, rawValue);

      // Ensure .detent/ exists (creates on demand)
      ensureRepoDetentDir(repoRoot);

      const config = loadRepoConfig(repoRoot);
      const updated: GlobalConfig = { ...config, [key]: parsed };
      saveRepoConfig(updated, repoRoot);
      console.log("ok");
    } catch (error) {
      // Redact sensitive data (API keys, tokens) before logging
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(redactSensitiveData(message));
      process.exit(1);
    }
  },
});
