import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractedError } from "@detent/parser";
import type { PreflightResult, StaleError, ValidationReason } from "./types.js";

const normalizeLine = (line: string): string =>
  line.trim().replace(/\s+/g, " ");

const groupByFile = (
  errors: ExtractedError[]
): Map<string, ExtractedError[]> => {
  const groups = new Map<string, ExtractedError[]>();
  for (const error of errors) {
    if (error.file) {
      const existing = groups.get(error.file);
      if (existing) {
        existing.push(error);
      } else {
        groups.set(error.file, [error]);
      }
    }
  }
  return groups;
};

const processFileErrors = (
  _filePath: string,
  fileErrors: ExtractedError[],
  _repoRoot: string,
  fileLines: string[]
): {
  valid: ExtractedError[];
  stale: StaleError[];
} => {
  const valid: ExtractedError[] = [];
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
  _filePath: string,
  fileErrors: ExtractedError[]
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
  error: ExtractedError,
  fileLines: string[]
): { valid: true } | { valid: false; reason: ValidationReason } => {
  // No line number or explicitly unknown - can't validate, assume valid
  if (!error.line || error.lineKnown === false) {
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
  errors: ExtractedError[],
  repoRoot: string
): PreflightResult => {
  const valid: ExtractedError[] = [];
  const stale: StaleError[] = [];

  // Errors without file path pass through as valid
  const withFile: ExtractedError[] = [];
  for (const error of errors) {
    if (error.file) {
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
    const { lines, stale: fileStale } = readFileLines(
      fullPath,
      filePath,
      fileErrors
    );
    stale.push(...fileStale);

    if (lines !== null) {
      const { valid: fileValid, stale: fileStaleFromProcess } =
        processFileErrors(filePath, fileErrors, repoRoot, lines);
      valid.push(...fileValid);
      stale.push(...fileStaleFromProcess);
    }
  }

  return { valid, stale };
};
