import type { DetectedTool } from "./types.js";

const TS_PAREN_PATTERN = /\.tsx?\(\d+,\d+\):\s*(?:error|warning)/i;
const TS_COLON_PATTERN = /\.tsx?:\d+:\d+\s+-\s+(?:error|warning)/i;

const detectFromJson = (parsed: unknown): DetectedTool | null => {
  if (Array.isArray(parsed)) {
    if (
      parsed.length > 0 &&
      "messages" in parsed[0] &&
      "filePath" in parsed[0]
    ) {
      return "eslint";
    }
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  if (
    "results" in parsed &&
    Array.isArray((parsed as { results: unknown }).results)
  ) {
    const results = (parsed as { results: unknown[] }).results;
    const firstResult = results[0];
    if (
      results.length > 0 &&
      firstResult &&
      typeof firstResult === "object" &&
      "messages" in firstResult
    ) {
      return "eslint";
    }
  }

  if (
    "testResults" in parsed &&
    Array.isArray((parsed as { testResults: unknown }).testResults)
  ) {
    return "vitest";
  }

  if (
    "Issues" in parsed &&
    Array.isArray((parsed as { Issues: unknown }).Issues)
  ) {
    return "golangci";
  }

  return null;
};

const detectFromNdjson = (firstLine: string): DetectedTool | null => {
  try {
    const parsed = JSON.parse(firstLine.trim());
    if (
      parsed.reason === "compiler-message" ||
      parsed.reason === "compiler-artifact"
    ) {
      return "cargo";
    }
  } catch {
    // Not valid JSON
  }
  return null;
};

// Quick check for TypeScript file extensions before running regex
const TS_EXTENSION_CHECK = /\.tsx?[:(]/;

/**
 * Maximum characters to scan for text-based detection.
 * Limits regex processing to prevent ReDoS on large malformed inputs.
 */
const MAX_DETECTION_SCAN_LENGTH = 50_000;

const detectFromText = (content: string): DetectedTool | null => {
  // Limit scan length to prevent ReDoS on large inputs
  const scanContent =
    content.length > MAX_DETECTION_SCAN_LENGTH
      ? content.slice(0, MAX_DETECTION_SCAN_LENGTH)
      : content;

  // Fast path: if no TypeScript extensions found, skip expensive regex
  if (!TS_EXTENSION_CHECK.test(scanContent)) {
    return null;
  }
  if (
    TS_PAREN_PATTERN.test(scanContent) ||
    TS_COLON_PATTERN.test(scanContent)
  ) {
    return "typescript";
  }
  return null;
};

export const detectTool = (content: string): DetectedTool | null => {
  const trimmed = content.trim();

  try {
    const parsed = JSON.parse(trimmed);
    const result = detectFromJson(parsed);
    if (result) {
      return result;
    }
  } catch {
    // Not valid JSON, continue to other detection methods
  }

  // Extract first line without splitting entire content
  const newlineIdx = trimmed.indexOf("\n");
  const firstLine = newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx);
  if (firstLine) {
    const ndjsonResult = detectFromNdjson(firstLine);
    if (ndjsonResult) {
      return ndjsonResult;
    }
  }

  return detectFromText(trimmed);
};
