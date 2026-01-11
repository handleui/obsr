/**
 * Global user preferences for Detent CLI
 *
 * Unlike per-repo config, preferences are global (~/.detent/preferences.json)
 * and control CLI behavior across all repositories.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface Preferences {
  /** Enable automatic updates at CLI startup (default: true) */
  autoUpdate: boolean;
}

interface PreferencesFile {
  $schema?: string;
  autoUpdate?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const PREFERENCES_FILE = "preferences.json";
const SCHEMA_URL = "./preferences-schema.json";
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[/\\]/;

const DEFAULTS: Preferences = {
  autoUpdate: true,
};

// ============================================================================
// Path Helpers
// ============================================================================

const getPreferencesDir = (): string => {
  const override = process.env.DETENT_HOME;
  if (
    override &&
    !override.includes("..") &&
    (override.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(override))
  ) {
    return override;
  }
  return join(homedir(), ".detent");
};

const getPreferencesPath = (): string =>
  join(getPreferencesDir(), PREFERENCES_FILE);

// ============================================================================
// Load / Save
// ============================================================================

/**
 * Load user preferences from ~/.detent/preferences.json
 * Returns defaults if file doesn't exist or is corrupted
 */
export const loadPreferences = (): Preferences => {
  const prefsPath = getPreferencesPath();

  if (!existsSync(prefsPath)) {
    return { ...DEFAULTS };
  }

  try {
    const data = readFileSync(prefsPath, "utf-8");
    if (!data.trim()) {
      return { ...DEFAULTS };
    }

    const parsed = JSON.parse(data) as PreferencesFile;

    return {
      autoUpdate:
        typeof parsed.autoUpdate === "boolean"
          ? parsed.autoUpdate
          : DEFAULTS.autoUpdate,
    };
  } catch {
    // Corrupted file - return defaults
    return { ...DEFAULTS };
  }
};

/**
 * Save user preferences to ~/.detent/preferences.json
 */
export const savePreferences = (prefs: Partial<Preferences>): void => {
  const prefsPath = getPreferencesPath();
  const dir = dirname(prefsPath);

  // Load existing preferences and merge
  const existing = loadPreferences();
  const merged: Preferences = {
    ...existing,
    ...prefs,
  };

  // Prepare file content
  const fileContent: PreferencesFile = {
    $schema: SCHEMA_URL,
    autoUpdate: merged.autoUpdate,
  };

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(prefsPath, `${JSON.stringify(fileContent, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch {
    // Silent fail - preferences are not critical
  }
};

/**
 * Get a single preference value
 */
export const getPreference = <K extends keyof Preferences>(
  key: K
): Preferences[K] => {
  return loadPreferences()[key];
};

/**
 * Set a single preference value
 */
export const setPreference = <K extends keyof Preferences>(
  key: K,
  value: Preferences[K]
): void => {
  savePreferences({ [key]: value });
};

// ============================================================================
// Validation
// ============================================================================

export const PREFERENCE_KEYS = ["autoUpdate"] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];

export const isPreferenceKey = (key: string): key is PreferenceKey => {
  return PREFERENCE_KEYS.includes(key as PreferenceKey);
};

/**
 * Parse a string value into the correct type for a preference
 */
export const parsePreferenceValue = (
  key: PreferenceKey,
  value: string
): boolean => {
  switch (key) {
    case "autoUpdate": {
      const lower = value.toLowerCase();
      if (
        lower === "true" ||
        lower === "on" ||
        lower === "1" ||
        lower === "yes"
      ) {
        return true;
      }
      if (
        lower === "false" ||
        lower === "off" ||
        lower === "0" ||
        lower === "no"
      ) {
        return false;
      }
      throw new Error(
        `Invalid value for ${key}: expected true/false, on/off, yes/no, or 1/0`
      );
    }
    default:
      throw new Error(`Unknown preference key: ${key}`);
  }
};

/**
 * Format a preference value for display
 */
export const formatPreferenceValue = (
  key: PreferenceKey,
  value: unknown
): string => {
  switch (key) {
    case "autoUpdate":
      return value ? "on" : "off";
    default:
      return String(value);
  }
};
