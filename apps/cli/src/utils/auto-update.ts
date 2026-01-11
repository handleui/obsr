/**
 * Automatic Update System for Detent CLI
 *
 * Industry-standard patterns implemented:
 * - Background cache refresh (non-blocking startup)
 * - 24-hour cache to minimize network calls
 * - Lock file to prevent concurrent updates
 * - CI environment detection (auto-disabled)
 * - Graceful degradation (failures don't break CLI)
 * - Signal handling during updates
 * - Retry with exponential backoff
 *
 * Disable via:
 * - DETENT_NO_AUTO_UPDATE=1 environment variable
 * - `detent config set autoUpdate off`
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compare, valid } from "semver";

// ============================================================================
// Constants
// ============================================================================

const MANIFEST_URL = "https://detent.sh/api/cli/manifest.json";
const INSTALL_SCRIPT_URL = "https://detent.sh/install.sh";

const CACHE_FILE = "update-cache.json";
const LOCK_FILE = "update.lock";

/** Cache duration - 24 hours between version checks */
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;

/** Lock file stale threshold - 5 minutes (handles crashed processes) */
const LOCK_STALE_MS = 5 * 60 * 1000;

/** HTTP timeout for manifest fetch */
const HTTP_TIMEOUT_MS = 5000;

/** Maximum response size to prevent memory exhaustion */
const MAX_RESPONSE_SIZE = 64 * 1024; // 64KB

/** Retry configuration for network failures */
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;

const VERSION_PREFIX_REGEX = /^v/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:\\/;

/** Commands that should skip auto-update to prevent loops */
const SKIP_UPDATE_COMMANDS = new Set([
  "update",
  "version",
  "--version",
  "-v",
  "--help",
  "-h",
  "help",
]);

/** CI environment variables to check */
const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "JENKINS_URL",
  "BUILDKITE",
  "TRAVIS",
  "AZURE_PIPELINES",
  "TEAMCITY_VERSION",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
  "TF_BUILD",
] as const;

// ============================================================================
// Types
// ============================================================================

interface Manifest {
  latest: string;
  versions?: string[];
}

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

interface UpdateLock {
  pid: number;
  startedAt: number;
}

interface UpdateCheckResult {
  hasUpdate: boolean;
  latestVersion: string | null;
  currentVersion: string;
}

export interface AutoUpdateOptions {
  currentVersion: string;
  args: string[];
  silent?: boolean;
}

export interface AutoUpdateResult {
  checked: boolean;
  updated: boolean;
  fromVersion?: string;
  toVersion?: string;
  error?: string;
}

// ============================================================================
// Path Helpers
// ============================================================================

const getDetentDir = (): string => {
  const override = process.env.DETENT_HOME;
  // Validate override path for security
  if (
    override &&
    !override.includes("..") &&
    (override.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(override))
  ) {
    return override;
  }
  return join(homedir(), ".detent");
};

const getCachePath = (): string => join(getDetentDir(), CACHE_FILE);
const getLockPath = (): string => join(getDetentDir(), LOCK_FILE);

// ============================================================================
// Lock File Management
// ============================================================================

/**
 * Acquire an exclusive lock to prevent concurrent updates.
 * Uses a file-based lock with PID and timestamp for stale detection.
 */
const acquireLock = (): boolean => {
  const lockPath = getLockPath();
  const dir = dirname(lockPath);

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    if (existsSync(lockPath)) {
      try {
        const lockData = JSON.parse(
          readFileSync(lockPath, "utf-8")
        ) as UpdateLock;
        const lockAge = Date.now() - lockData.startedAt;

        // Stale lock detection - process likely crashed
        if (lockAge > LOCK_STALE_MS) {
          unlinkSync(lockPath);
        } else {
          return false;
        }
      } catch {
        // Corrupted lock file - remove it
        unlinkSync(lockPath);
      }
    }

    const lock: UpdateLock = {
      pid: process.pid,
      startedAt: Date.now(),
    };
    writeFileSync(lockPath, JSON.stringify(lock), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
};

const releaseLock = (): void => {
  try {
    const lockPath = getLockPath();
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // Silent fail - lock will become stale
  }
};

// ============================================================================
// Cache Management
// ============================================================================

const loadCache = (): UpdateCache | null => {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const data = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(data) as UpdateCache;

    // Validate cache structure
    if (
      typeof parsed.lastCheck !== "number" ||
      typeof parsed.latestVersion !== "string"
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

const saveCache = (cache: UpdateCache): void => {
  const cachePath = getCachePath();
  const dir = dirname(cachePath);

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(cachePath, JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // Silent fail - cache is not critical
  }
};

// ============================================================================
// Network Operations
// ============================================================================

/**
 * Sleep helper for retry backoff
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch latest version from manifest with retry and exponential backoff.
 */
const fetchLatestVersion = async (): Promise<string | null> => {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1000ms, 2000ms
      await sleep(INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(MANIFEST_URL, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        continue;
      }

      // Size check before reading body
      const contentLength = response.headers.get("content-length");
      if (
        contentLength &&
        Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE
      ) {
        return null; // Don't retry - server misconfiguration
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_SIZE) {
        return null;
      }

      const manifest = JSON.parse(text) as Manifest;

      if (!manifest.latest) {
        return null;
      }

      const version = manifest.latest.replace(VERSION_PREFIX_REGEX, "");
      if (!valid(version)) {
        return null;
      }

      return manifest.latest;
    } catch {
      clearTimeout(timeoutId);
      // Continue to retry
    }
  }

  // All retries exhausted
  return null;
};

// ============================================================================
// Version Comparison
// ============================================================================

const compareVersions = (
  current: string,
  latest: string
): { hasUpdate: boolean; latestVersion: string } => {
  const currentClean = current.replace(VERSION_PREFIX_REGEX, "");
  const latestClean = latest.replace(VERSION_PREFIX_REGEX, "");

  if (!(valid(currentClean) && valid(latestClean))) {
    return { hasUpdate: false, latestVersion: latest };
  }

  const result = compare(latestClean, currentClean);
  return {
    hasUpdate: result > 0,
    latestVersion: latest.startsWith("v") ? latest : `v${latest}`,
  };
};

const isDevVersion = (version: string): boolean => {
  return !version || version === "dev" || version === "0.0.0";
};

// ============================================================================
// Update Check
// ============================================================================

const checkForUpdate = async (
  currentVersion: string
): Promise<UpdateCheckResult> => {
  const result: UpdateCheckResult = {
    hasUpdate: false,
    latestVersion: null,
    currentVersion,
  };

  if (isDevVersion(currentVersion)) {
    return result;
  }

  const cache = loadCache();
  const now = Date.now();

  // Use cache if fresh
  if (cache && now - cache.lastCheck < CACHE_DURATION_MS) {
    const { hasUpdate, latestVersion } = compareVersions(
      currentVersion,
      cache.latestVersion
    );
    return { hasUpdate, latestVersion, currentVersion };
  }

  // Fetch latest version (with retries)
  const latest = await fetchLatestVersion();

  if (latest === null) {
    // Fall back to stale cache if available
    if (cache) {
      const { hasUpdate, latestVersion } = compareVersions(
        currentVersion,
        cache.latestVersion
      );
      return { hasUpdate, latestVersion, currentVersion };
    }
    return result;
  }

  // Update cache
  saveCache({ lastCheck: now, latestVersion: latest });

  const { hasUpdate, latestVersion } = compareVersions(currentVersion, latest);
  return { hasUpdate, latestVersion, currentVersion };
};

// ============================================================================
// Update Execution
// ============================================================================

/**
 * Execute the update by running the install script.
 * Handles SIGINT/SIGTERM gracefully during update.
 */
const runUpdate = (): Promise<boolean> =>
  new Promise((resolve) => {
    const proc = spawn(
      "bash",
      ["-c", `set -o pipefail; curl -fsSL ${INSTALL_SCRIPT_URL} | bash`],
      { stdio: "inherit" }
    );

    // Forward signals to child process
    const signalHandler = (signal: NodeJS.Signals): void => {
      proc.kill(signal);
    };

    process.on("SIGINT", signalHandler);
    process.on("SIGTERM", signalHandler);

    proc.on("close", (code) => {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
      resolve(code === 0);
    });

    proc.on("error", () => {
      process.off("SIGINT", signalHandler);
      process.off("SIGTERM", signalHandler);
      resolve(false);
    });
  });

// ============================================================================
// Background Cache Refresh
// ============================================================================

/**
 * Spawn a detached process to refresh the cache in background.
 * This allows the main CLI to continue without waiting for network.
 */
const spawnBackgroundRefresh = (): void => {
  const cachePath = getCachePath();
  const script = `
    const https = require('https');
    const fs = require('fs');
    const path = require('path');

    const MANIFEST_URL = '${MANIFEST_URL}';
    const CACHE_PATH = '${cachePath}';

    https.get(MANIFEST_URL, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) return;
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const manifest = JSON.parse(data);
          if (manifest.latest) {
            const dir = path.dirname(CACHE_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(CACHE_PATH, JSON.stringify({
              lastCheck: Date.now(),
              latestVersion: manifest.latest
            }), { mode: 0o600 });
          }
        } catch {}
      });
    }).on('error', () => {});
  `;

  try {
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Silent fail
  }
};

// ============================================================================
// Configuration Checks
// ============================================================================

/**
 * Detect if running in a CI environment.
 */
const isCI = (): boolean => {
  for (const envVar of CI_ENV_VARS) {
    const value = process.env[envVar];
    if (value && value !== "false" && value !== "0") {
      return true;
    }
  }
  return false;
};

/**
 * Check if auto-update is disabled via environment, CI, or preferences.
 *
 * Priority:
 * 1. DETENT_NO_AUTO_UPDATE env var (explicit override)
 * 2. CI environment detection (always disabled)
 * 3. User preference from ~/.detent/preferences.json
 */
const isAutoUpdateDisabled = (): boolean => {
  // Explicit env var override
  const envDisabled = process.env.DETENT_NO_AUTO_UPDATE;
  if (envDisabled === "1" || envDisabled === "true") {
    return true;
  }

  // Never auto-update in CI
  if (isCI()) {
    return true;
  }

  // Check user preference (lazy import to keep module lightweight)
  try {
    const { getPreference } =
      require("../lib/preferences.js") as typeof import("../lib/preferences.js");
    if (!getPreference("autoUpdate")) {
      return true;
    }
  } catch {
    // If preferences can't be loaded, default to enabled
  }

  return false;
};

/**
 * Check if the current command should skip auto-update.
 */
const shouldSkipForCommand = (args: string[]): boolean => {
  const command = args[0];
  if (!command) {
    return true; // No command = help screen
  }
  return SKIP_UPDATE_COMMANDS.has(command);
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Main entry point for automatic updates.
 *
 * Called at CLI startup to check for and apply updates transparently.
 * Designed to be fast (uses cache) and non-disruptive (graceful failures).
 */
export const maybeAutoUpdate = async (
  options: AutoUpdateOptions
): Promise<AutoUpdateResult> => {
  const { currentVersion, args, silent = false } = options;

  // Skip for dev versions
  if (isDevVersion(currentVersion)) {
    return { checked: false, updated: false };
  }

  // Skip if disabled (env, CI, or preference)
  if (isAutoUpdateDisabled()) {
    // Still refresh cache in background for manual `detent update`
    const cache = loadCache();
    if (!cache || Date.now() - cache.lastCheck >= CACHE_DURATION_MS) {
      spawnBackgroundRefresh();
    }
    return { checked: false, updated: false };
  }

  // Skip for certain commands
  if (shouldSkipForCommand(args)) {
    return { checked: false, updated: false };
  }

  // Check for updates
  const { hasUpdate, latestVersion } = await checkForUpdate(currentVersion);

  if (!(hasUpdate && latestVersion)) {
    return { checked: true, updated: false };
  }

  // Acquire lock (prevent concurrent updates)
  if (!acquireLock()) {
    return {
      checked: true,
      updated: false,
      error: "Update already in progress",
    };
  }

  try {
    if (!silent) {
      console.log(`Updating detent: v${currentVersion} → ${latestVersion}`);
    }

    const success = await runUpdate();

    if (success) {
      if (!silent) {
        console.log("Update complete. Restarting...\n");
      }
      return {
        checked: true,
        updated: true,
        fromVersion: currentVersion,
        toVersion: latestVersion,
      };
    }

    if (!silent) {
      console.log("Update failed. Continuing with current version.\n");
    }
    return {
      checked: true,
      updated: false,
      error: "Update failed",
    };
  } finally {
    releaseLock();
  }
};

/**
 * Force a version check, ignoring cache.
 * Used by the `detent update` command.
 */
export const forceCheckForUpdate = async (
  currentVersion: string
): Promise<UpdateCheckResult> => {
  const result: UpdateCheckResult = {
    hasUpdate: false,
    latestVersion: null,
    currentVersion,
  };

  if (isDevVersion(currentVersion)) {
    return result;
  }

  const latest = await fetchLatestVersion();

  if (latest === null) {
    return result;
  }

  // Update cache
  saveCache({ lastCheck: Date.now(), latestVersion: latest });

  const { hasUpdate, latestVersion } = compareVersions(currentVersion, latest);
  return { hasUpdate, latestVersion, currentVersion };
};

/**
 * Run the update script.
 * Exported for use by the `update` command.
 */
export { runUpdate };
