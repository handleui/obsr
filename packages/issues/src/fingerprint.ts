import { createHash } from "node:crypto";
import type { IssueFingerprints } from "@obsr/types";
import {
  normalizeFingerprintFilePath,
  normalizeForFingerprintMessage,
} from "./fingerprint-normalize.js";

export interface FingerprintableDiagnostic {
  message: string;
  source?: string;
  ruleId?: string;
  filePath?: string;
  line?: number | null;
  column?: number | null;
}

const hash = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, 16);

export const generateFingerprints = (
  diagnostic: FingerprintableDiagnostic
): IssueFingerprints => {
  const normalizedPattern = normalizeForFingerprintMessage(diagnostic.message);

  const loreInput = [
    diagnostic.source ?? "unknown",
    diagnostic.ruleId ?? "",
    normalizedPattern,
  ].join(":");
  const lore = hash(loreInput);

  const normalizedFile = diagnostic.filePath
    ? normalizeFingerprintFilePath(diagnostic.filePath)
    : "";
  const repoInput = `${lore}:${normalizedFile}`;
  const repo = hash(repoInput);

  const instanceInput = `${repo}:${diagnostic.line ?? 0}:${diagnostic.column ?? 0}`;
  const instance = hash(instanceInput);

  return { lore, repo, instance, normalizedPattern };
};
