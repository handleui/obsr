import { existsSync } from "node:fs";
import { join } from "node:path";

import { getDetentHome } from "../../../lib/env.js";
import { ACT_VERSION } from "./version.js";

/**
 * Gets the global detent directory
 * Uses ~/.detent-dev in development and ~/.detent in production
 */
export const getGlobalDetentDir = getDetentHome;

/**
 * @deprecated Use getGlobalDetentDir() instead
 */
export const getDetentDir = getDetentHome;

export const getBinDir = (): string => {
  return join(getGlobalDetentDir(), "bin");
};

export const getActPath = (): string => {
  const binDir = getBinDir();
  const binaryName = `act-${ACT_VERSION}${process.platform === "win32" ? ".exe" : ""}`;
  return join(binDir, binaryName);
};

export const isInstalled = (): boolean => {
  const actPath = getActPath();
  return existsSync(actPath);
};
