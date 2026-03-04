import { createHash } from "node:crypto";
import type { ErrorFingerprints } from "@detent/types";
import type { CIError } from "../types.js";
import { normalizeFilePath, normalizeForLore } from "./normalize.js";

export type { ErrorFingerprints } from "@detent/types";
export {
  normalizeFilePath,
  normalizeForLore,
  sanitizeSensitiveData,
} from "./normalize.js";

const hash = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 16);

/**
 * Generate hierarchical fingerprints for an error.
 *
 * - lore: cross-repo matching (source:ruleId:normalizedPattern)
 * - repo: per-repo tracking (lore + normalized file path)
 * - instance: exact dedup (repo + line + column)
 */
export const generateFingerprints = (error: CIError): ErrorFingerprints => {
  const normalizedPattern = normalizeForLore(error.message);

  // Level 1: Lore fingerprint (cross-repo)
  const loreInput = [
    error.source ?? "unknown",
    error.ruleId ?? "",
    normalizedPattern,
  ].join(":");
  const lore = hash(loreInput);

  // Level 2: Repo fingerprint (per-repo tracking)
  const normalizedFile = error.filePath
    ? normalizeFilePath(error.filePath)
    : "";
  const repoInput = `${lore}:${normalizedFile}`;
  const repo = hash(repoInput);

  // Level 3: Instance fingerprint (exact dedup)
  const instanceInput = `${repo}:${error.line ?? 0}:${error.column ?? 0}`;
  const instance = hash(instanceInput);

  return { lore, repo, instance, normalizedPattern };
};

/** Legacy: simple signature for backward compatibility */
export const generateSignature = (error: CIError): string => {
  return generateFingerprints(error).lore;
};
