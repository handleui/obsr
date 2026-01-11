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

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes - consider lock stale after this
const HTTP_TIMEOUT_MS = 5000;
const MAX_RESPONSE_SIZE = 64 * 1024; // 64KB

const VERSION_PREFIX_REGEX = /^v/;

// Commands that should skip auto-update
const SKIP_UPDATE_COMMANDS = new Set(["update", "version", "--version", "-v"]);

// ============================================================================
// Types
// ============================================================================

interface Manifest {
  latest: string;
  versions: string[];
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

// ============================================================================
// Path Helpers
// ============================================================================

const getDetentDir = (): string => {
  const home = process.env.DETENT_HOME || homedir();
  return join(home, ".detent");
};

const getCachePath = (): string => join(getDetentDir(), CACHE_FILE);
const getLockPath = (): string => join(getDetentDir(), LOCK_FILE);

// ============================================================================
// Lock File Management (prevents concurrent updates)
// ============================================================================

const acquireLock = (): boolean => {
  const lockPath = getLockPath();
  const dir = dirname(lockPath);

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Check for existing lock
    if (existsSync(lockPath)) {
      const lockData = JSON.parse(
        readFileSync(lockPath, "utf-8")
      ) as UpdateLock;
      const lockAge = Date.now() - lockData.startedAt;

      // If lock is stale (process likely crashed), remove it
      if (lockAge > LOCK_STALE_MS) {
        unlinkSync(lockPath);
      } else {
        // Another update is in progress
        return false;
      }
    }

    // Create lock
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
    // Silent fail
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
    return JSON.parse(data) as UpdateCache;
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
    // Silent fail
  }
};

// ============================================================================
// Version Fetching & Comparison
// ============================================================================

const fetchLatestVersion = async (): Promise<string | null> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(MANIFEST_URL, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const contentLength = response.headers.get("content-length");
    if (
      contentLength &&
      Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE
    ) {
      return null;
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
    return null;
  }
};

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

  // Skip dev versions
  if (
    !currentVersion ||
    currentVersion === "dev" ||
    currentVersion === "0.0.0"
  ) {
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

  // Fetch latest version
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

const runUpdate = (): Promise<boolean> =>
  new Promise((resolve) => {
    const proc = spawn(
      "bash",
      ["-c", `set -o pipefail; curl -fsSL ${INSTALL_SCRIPT_URL} | bash`],
      { stdio: "inherit" }
    );

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });

// ============================================================================
// Background Cache Refresh
// ============================================================================

const spawnBackgroundRefresh = (): void => {
  const script = `
    const https = require('https');
    const fs = require('fs');
    const path = require('path');

    const MANIFEST_URL = '${MANIFEST_URL}';
    const CACHE_PATH = '${getCachePath()}';

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
// Configuration
// ============================================================================

/**
 * Check if auto-update is disabled via environment variable or config
 */
const isAutoUpdateDisabled = (): boolean => {
  // Environment variable takes precedence (explicit opt-out)
  const envDisabled = process.env.DETENT_NO_AUTO_UPDATE;
  if (envDisabled === "1" || envDisabled === "true") {
    return true;
  }

  // Check CI environments - never auto-update in CI
  if (
    process.env.CI === "true" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.GITLAB_CI === "true" ||
    process.env.CIRCLECI === "true" ||
    process.env.JENKINS_URL ||
    process.env.BUILDKITE === "true"
  ) {
    return true;
  }

  return false;
};

/**
 * Check if the current command should skip auto-update
 */
const shouldSkipForCommand = (args: string[]): boolean => {
  // Skip if no args (help screen)
  const command = args[0];
  if (!command) {
    return true;
  }

  return SKIP_UPDATE_COMMANDS.has(command);
};

// ============================================================================
// Public API
// ============================================================================

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

/**
 * Performs automatic update check and update if available.
 *
 * Industry-standard behavior:
 * - Checks version against cached manifest (24h cache)
 * - Refreshes cache in background if stale
 * - Applies update automatically if available
 * - Skips in CI environments
 * - Respects DETENT_NO_AUTO_UPDATE env var
 * - Uses lock file to prevent concurrent updates
 *
 * @returns Result indicating what happened
 */
export const maybeAutoUpdate = async (
  options: AutoUpdateOptions
): Promise<AutoUpdateResult> => {
  const { currentVersion, args, silent = false } = options;

  // Skip for dev versions
  if (
    !currentVersion ||
    currentVersion === "dev" ||
    currentVersion === "0.0.0"
  ) {
    return { checked: false, updated: false };
  }

  // Skip if disabled
  if (isAutoUpdateDisabled()) {
    // Still refresh cache in background for when user runs `detent update`
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
    // Show update message
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

    // Update failed - continue with current version
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
 * Used by the `update` command.
 */
export const forceCheckForUpdate = async (
  currentVersion: string
): Promise<UpdateCheckResult> => {
  const result: UpdateCheckResult = {
    hasUpdate: false,
    latestVersion: null,
    currentVersion,
  };

  if (
    !currentVersion ||
    currentVersion === "dev" ||
    currentVersion === "0.0.0"
  ) {
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
