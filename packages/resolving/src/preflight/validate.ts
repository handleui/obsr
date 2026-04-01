import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CIError } from "@obsr/types";

import type { PreflightResult, StaleError, ValidationReason } from "./types.js";

const normalizeLine = (line: string): string =>
  line.trim().replace(/\s+/g, " ");

const groupByFile = (errors: CIError[]): Map<string, CIError[]> => {
  const groups = new Map<string, CIError[]>();
  for (const error of errors) {
    if (error.filePath) {
      const existing = groups.get(error.filePath);
      if (existing) {
        existing.push(error);
      } else {
        groups.set(error.filePath, [error]);
      }
    }
  }
  return groups;
};

const processFileErrors = (
  fileErrors: CIError[],
  fileLines: string[]
): {
  valid: CIError[];
  stale: StaleError[];
} => {
  const valid: CIError[] = [];
  const stale: StaleError[] = [];

  for (const error of fileErrors) {
    const result = validateSingle(error, fileLines);
    if (result.valid) {
      valid.push(error);
    } else {
      stale.push({ error, reason: result.reason });
    }
  }

  return { valid, stale };
};

const readFileLines = (
  fullPath: string,
  fileErrors: CIError[]
): {
  lines: string[] | null;
  stale: StaleError[];
} => {
  if (!existsSync(fullPath)) {
    const stale = fileErrors.map((error) => ({
      error,
      reason: "file_missing" as const,
    }));
    return { lines: null, stale };
  }

  try {
    const content = readFileSync(fullPath, "utf-8");
    return { lines: content.split("\n"), stale: [] };
  } catch {
    const stale = fileErrors.map((error) => ({
      error,
      reason: "file_missing" as const,
    }));
    return { lines: null, stale };
  }
};

const validateSingle = (
  error: CIError,
  fileLines: string[]
): { valid: true } | { valid: false; reason: ValidationReason } => {
  // No line number - can't validate, assume valid
  if (!error.line) {
    return { valid: true };
  }

  // Line out of bounds
  if (error.line > fileLines.length) {
    return { valid: false, reason: "line_out_of_bounds" };
  }

  // No code snippet - can't compare, assume valid
  if (!error.codeSnippet?.lines?.length) {
    return { valid: true };
  }

  // Compare stored snippet against current code
  const { lines: storedLines, startLine } = error.codeSnippet;
  const currentLines = fileLines.slice(
    startLine - 1,
    startLine - 1 + storedLines.length
  );

  // Length mismatch means code changed
  if (storedLines.length !== currentLines.length) {
    return { valid: false, reason: "code_changed" };
  }

  // Compare normalized lines
  for (let i = 0; i < storedLines.length; i++) {
    const stored = storedLines[i] ?? "";
    const current = currentLines[i] ?? "";
    if (normalizeLine(stored) !== normalizeLine(current)) {
      return { valid: false, reason: "code_changed" };
    }
  }

  return { valid: true };
};

export const validateErrors = (
  errors: CIError[],
  repoRoot: string
): PreflightResult => {
  const valid: CIError[] = [];
  const stale: StaleError[] = [];

  // Errors without file path pass through as valid
  const withFile: CIError[] = [];
  for (const error of errors) {
    if (error.filePath) {
      withFile.push(error);
    } else {
      valid.push(error);
    }
  }

  // Group by file to minimize reads
  const byFile = groupByFile(withFile);

  for (const [filePath, fileErrors] of byFile) {
    const fullPath = join(repoRoot, filePath);

    // Prevent path traversal attacks
    if (!fullPath.startsWith(`${repoRoot}/`)) {
      for (const error of fileErrors) {
        stale.push({ error, reason: "file_missing" });
      }
      continue;
    }

    // Read and validate file
    const { lines, stale: fileStale } = readFileLines(fullPath, fileErrors);
    stale.push(...fileStale);

    if (lines !== null) {
      const { valid: fileValid, stale: fileStaleFromProcess } =
        processFileErrors(fileErrors, lines);
      valid.push(...fileValid);
      stale.push(...fileStaleFromProcess);
    }
  }

  return { valid, stale };
};
