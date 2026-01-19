/**
 * Code snippet extraction for error context.
 * Reads source code around an error location.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

export interface CodeSnippet {
  lines: string[];
  startLine: number;
  /** 1-indexed position of the error line within the snippet (not the actual source line number) */
  errorLineOffset: number;
  language: string;
}

/**
 * Map of file extensions to language identifiers.
 */
const extensionToLanguage: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

/**
 * Detect the programming language from a file extension.
 */
const detectLanguage = (filePath: string): string => {
  const ext = extname(filePath).toLowerCase();
  return extensionToLanguage[ext] ?? "text";
};

/** Number of context lines before and after the error line */
const CONTEXT_LINES = 3;

/** Maximum file size to read for snippets (1MB) - prevents memory issues */
const MAX_SNIPPET_FILE_SIZE = 1024 * 1024;

/**
 * Read a code snippet around an error location.
 *
 * @param filePath - Path to the source file
 * @param errorLine - 1-indexed line number of the error
 * @returns CodeSnippet or undefined if file can't be read
 */
export const readSnippet = (
  filePath: string,
  errorLine: number
): CodeSnippet | undefined => {
  // Validate inputs
  if (!filePath || errorLine <= 0) {
    return undefined;
  }

  // Check file exists
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    // Skip very large files to avoid memory issues
    const stats = statSync(filePath);
    if (stats.size > MAX_SNIPPET_FILE_SIZE) {
      return undefined;
    }

    const content = readFileSync(filePath, "utf-8");
    const allLines = content.split("\n");

    // Calculate line range (1-indexed)
    const startLine = Math.max(1, errorLine - CONTEXT_LINES);
    const endLine = Math.min(allLines.length, errorLine + CONTEXT_LINES);

    // Extract lines (convert to 0-indexed for array access)
    const lines = allLines.slice(startLine - 1, endLine);

    // Calculate error line position within snippet (1-indexed)
    const errorLineInSnippet = errorLine - startLine + 1;

    return {
      lines,
      startLine,
      errorLineOffset: errorLineInSnippet,
      language: detectLanguage(filePath),
    };
  } catch {
    return undefined;
  }
};
