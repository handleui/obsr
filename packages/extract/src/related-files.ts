const MAX_RELATED_FILES = 10;

const MAX_STACKTRACE_LENGTH = 1024 * 1024;

const FILE_PATH_PATTERNS = [
  /\(([^()]+\.[a-z]+):\d+(?::\d+)?\)/gi,
  /at\s+([^\s():]+\.[a-z]+):\d+(?::\d+)?$/gim,
  /File\s+"([^"]+)"/gi,
  /(?:^|\s)(\/[\w./-]+\.[a-z]+):\d+(?::\d+)?/gim,
  /(?:^|\s)([A-Z]:\\[\w.\\/-]+\.[a-z]+):\d+(?::\d+)?/gim,
  /::(?:error|warning)\s+file=([^,\s:]+)/gi,
];

const EXCLUDED_PATTERNS = [
  /node_modules[\\/]/,
  /\.cargo[\\/]/,
  /site-packages[\\/]/,
  /vendor[\\/]/,
  /[\\/]__pycache__[\\/]/,
  /[\\/]\..*[\\/]/,
];

const HAS_EXTENSION_PATTERN = /\.[a-z]+$/i;

const LEADING_DOT_SLASH = /^\.\//;
const BACKSLASH = /\\/g;

export const extractRelatedFiles = (
  stackTrace: string | undefined | null,
  primaryFile?: string
): string[] => {
  if (!stackTrace) {
    return [];
  }

  const bounded =
    stackTrace.length > MAX_STACKTRACE_LENGTH
      ? stackTrace.slice(0, MAX_STACKTRACE_LENGTH)
      : stackTrace;

  const found = new Set<string>();
  const normalizedPrimary = primaryFile
    ? normalizeFilePath(primaryFile)
    : undefined;

  for (const pattern of FILE_PATH_PATTERNS) {
    pattern.lastIndex = 0;

    for (const match of bounded.matchAll(pattern)) {
      const filePath = match[1];
      if (filePath) {
        const normalized = normalizeFilePath(filePath);
        if (isValidFilePath(filePath, normalized, normalizedPrimary)) {
          found.add(normalized);
        }
      }
    }
  }

  return Array.from(found).slice(0, MAX_RELATED_FILES);
};

const isExcludedPath = (filePath: string): boolean =>
  EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath));

const isValidFilePath = (
  filePath: string,
  normalized: string,
  normalizedPrimary?: string
): boolean => {
  if (normalizedPrimary && normalized === normalizedPrimary) {
    return false;
  }
  if (isExcludedPath(filePath)) {
    return false;
  }
  if (!HAS_EXTENSION_PATTERN.test(filePath)) {
    return false;
  }
  if (filePath.startsWith("http") || filePath.startsWith("@")) {
    return false;
  }
  return isSafeRelativePath(filePath);
};

const isSafeRelativePath = (filePath: string): boolean => {
  if (filePath.includes("\0")) {
    return false;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(filePath);
  } catch {
    return false;
  }

  return !decoded.replace(/\\/g, "/").includes("..");
};

const normalizeFilePath = (filePath: string): string =>
  filePath.replace(LEADING_DOT_SLASH, "").replace(BACKSLASH, "/");
