/**
 * Parser for golangci-lint JSON output format.
 * Parses output from `golangci-lint run --out-format=json` or `--output.json.path`
 *
 * JSON structure:
 * {
 *   "Issues": [{
 *     "FromLinter": "errcheck",
 *     "Text": "Error return value not checked",
 *     "Severity": "error" | "warning",
 *     "SourceLines": ["..."],
 *     "Pos": { "Filename": "...", "Line": 123, "Column": 45 },
 *     "Replacement": { "NewLines": ["..."], "NeedOnlyDelete": false } | null
 *   }]
 * }
 */

import type { Diagnostic } from "../types.js";

interface GolangciPosition {
  Filename: string;
  Offset?: number;
  Line: number;
  Column: number;
}

interface GolangciReplacement {
  NewLines?: string[];
  NeedOnlyDelete?: boolean;
}

interface GolangciTextEdit {
  Pos?: number;
  End?: number;
  NewText?: string;
}

interface GolangciSuggestedFix {
  Message?: string;
  TextEdits?: GolangciTextEdit[];
}

interface GolangciIssue {
  FromLinter: string;
  Text: string;
  Severity?: string;
  SourceLines?: string[];
  Pos: GolangciPosition;
  Replacement?: GolangciReplacement | null;
  SuggestedFixes?: GolangciSuggestedFix[];
  LineRange?: { From: number; To: number };
  ExpectedNoLintLinter?: string;
  ExpectNoLint?: boolean;
}

interface GolangciOutput {
  Issues?: GolangciIssue[];
  Report?: {
    Warnings?: unknown[];
    Linters?: unknown[];
  };
}

/**
 * Extract hints from replacement and suggestedFixes.
 */
const extractHints = (
  replacement: GolangciReplacement | null | undefined,
  suggestedFixes: GolangciSuggestedFix[] | undefined
): string[] => {
  const hints: string[] = [];

  // Handle legacy Replacement field
  if (replacement?.NewLines && replacement.NewLines.length > 0) {
    hints.push(`Replace with: ${replacement.NewLines.join("\n")}`);
  } else if (replacement?.NeedOnlyDelete) {
    hints.push("Delete this code");
  }

  // Handle newer SuggestedFixes field
  if (suggestedFixes) {
    for (const fix of suggestedFixes) {
      if (fix.Message) {
        hints.push(fix.Message);
      }
    }
  }

  return hints;
};

/**
 * Determine if issue has a fix available.
 */
const hasFixAvailable = (issue: GolangciIssue): boolean =>
  issue.Replacement != null ||
  (issue.SuggestedFixes != null && issue.SuggestedFixes.length > 0);

/**
 * Convert a single golangci-lint issue to a Diagnostic.
 */
const issueToError = (issue: GolangciIssue): Diagnostic | null => {
  if (!(issue.Pos?.Filename && issue.Text)) {
    return null;
  }

  const severity: "error" | "warning" =
    issue.Severity?.toLowerCase() === "warning" ? "warning" : "error";

  const hints = extractHints(issue.Replacement, issue.SuggestedFixes);

  const error: Diagnostic = {
    message: issue.Text,
    filePath: issue.Pos.Filename,
    line: issue.Pos.Line,
    column: issue.Pos.Column > 0 ? issue.Pos.Column : undefined,
    severity,
    ruleId: issue.FromLinter,
    fixable: hasFixAvailable(issue),
    hints: hints.length > 0 ? hints : undefined,
  };

  if (issue.SourceLines && issue.SourceLines.length > 0) {
    error.stackTrace = issue.SourceLines.join("\n");
  }

  return error;
};

/**
 * Parse golangci-lint JSON output into Diagnostic array.
 *
 * @param content - Raw JSON string from golangci-lint --out-format=json
 * @returns Array of parsed errors
 */
export const parseGolangci = (content: string): Diagnostic[] => {
  let parsed: GolangciOutput;
  try {
    parsed = JSON.parse(content) as GolangciOutput;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed.Issues)) {
    return [];
  }

  const errors: Diagnostic[] = [];

  for (const issue of parsed.Issues) {
    const error = issueToError(issue);
    if (error) {
      errors.push(error);
    }
  }

  return errors;
};
