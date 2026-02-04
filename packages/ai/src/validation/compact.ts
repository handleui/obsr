// CI noise patterns to filter out
const NOISE_PATTERNS = [
  /^\s*$/,
  /^[-=]{3,}$/,
  /^\s*\d+\s+passing/i,
  /^\s*\d+\s+pending/i,
  /^npm\s+(warn|notice)/i,
  /^yarn\s+(warn|notice)/i,
  /^\s*at\s+(?:Object\.|Module\.|Function\.)/,
  /^\s*at\s+node:/,
  /^\s*at\s+internal\//,
  /^Downloading/i,
  /^Installing/i,
  /^Resolving/i,
  /^\s*\^+\s*$/,
  /^\s*~+\s*$/,
];

// Patterns that indicate important lines (keep these)
const IMPORTANT_PATTERNS = [
  /error/i,
  /warning/i,
  /failed/i,
  /failure/i,
  /exception/i,
  /:\d+:\d+/,
  /line\s+\d+/i,
  /^\s*>\s+\d+\s*\|/,
  /FAIL|PASS|ERROR|WARN/,
];

/**
 * Compacts CI output by removing noise while preserving errors.
 *
 * Filters:
 * - Empty lines and separators
 * - npm/yarn notices
 * - Internal stack frames (node:, internal/, etc.)
 * - Download/install progress
 *
 * Preserves:
 * - Lines with error/warning/failed
 * - File locations (file.ts:42:5)
 * - Code context lines
 * - Test results (FAIL, PASS)
 */
export const compactCiOutput = (content: string): string => {
  const lines = content.split("\n");
  const result: string[] = [];
  let consecutiveNoiseCount = 0;

  for (const line of lines) {
    const isNoise = NOISE_PATTERNS.some((p) => p.test(line));
    const isImportant = IMPORTANT_PATTERNS.some((p) => p.test(line));

    if (isImportant || !isNoise) {
      if (consecutiveNoiseCount > 3) {
        result.push(`... [${consecutiveNoiseCount} lines omitted]`);
      }
      consecutiveNoiseCount = 0;
      result.push(line);
    } else {
      consecutiveNoiseCount++;
    }
  }

  if (consecutiveNoiseCount > 3) {
    result.push(`... [${consecutiveNoiseCount} lines omitted]`);
  }

  return result.join("\n");
};

/**
 * Truncates content for the prompt to avoid excessive token usage.
 */
export const truncateContent = (
  content: string,
  maxLength = 15_000
): string => {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n... [truncated, ${content.length - maxLength} more characters]`;
};
