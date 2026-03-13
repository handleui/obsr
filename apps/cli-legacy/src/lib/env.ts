/**
 * Centralized environment configuration for Detent CLI
 *
 * Provides consistent paths and environment detection across all modules.
 * In development, data is stored in ~/.detent-dev to avoid clashing with
 * production installations.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// Injected at compile time for standalone binaries
declare const DETENT_PRODUCTION: boolean | undefined;

const DETENT_DIR_NAME = ".detent";
const DETENT_DEV_DIR_NAME = ".detent-dev";
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:\\/;

/**
 * Check if running in production mode (standalone binary)
 */
export const isProduction = (): boolean =>
  typeof DETENT_PRODUCTION !== "undefined";

/**
 * Validate an override path for security
 * Rejects paths with .. traversal or non-absolute paths
 */
const validateOverridePath = (path: string): string | null => {
  if (path.includes("..")) {
    return null;
  }
  if (!(path.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(path))) {
    return null;
  }
  return path;
};

/**
 * Get the global Detent home directory
 *
 * Priority:
 * 1. DETENT_HOME env var (explicit override, always respected)
 * 2. ~/.detent-dev in development mode
 * 3. ~/.detent in production mode
 *
 * This ensures local development doesn't clash with production installations.
 */
export const getDetentHome = (): string => {
  const override = process.env.DETENT_HOME;
  if (override) {
    const validated = validateOverridePath(override);
    if (validated) {
      return validated;
    }
  }

  const dirName = isProduction() ? DETENT_DIR_NAME : DETENT_DEV_DIR_NAME;
  return join(homedir(), dirName);
};
