/**
 * JSON parsers for CI tool output.
 * These parse structured JSON output from tools like ESLint, Vitest, Cargo, golangci-lint.
 * TypeScript uses regex parsing since tsc has no JSON reporter.
 *
 * These are local fallback parsers that extract errors when the API is not available.
 * When the API's /v1/diagnostics endpoint is accessible, it provides AI-powered extraction.
 */

import type { CIError } from "@detent/types";

// =============================================================================
// ESLint Parser
// =============================================================================

interface ESLintSuggestion {
  desc?: string;
}

interface ESLintFix {
  range: [number, number];
  text: string;
}

interface ESLintMessage {
  ruleId: string | null;
  severity: 0 | 1 | 2;
  message: string;
  line: number;
  column: number;
  fatal?: boolean;
  fix?: ESLintFix;
  suggestions?: ESLintSuggestion[];
}

interface ESLintResult {
  filePath: string;
  messages: ESLintMessage[];
}

type ESLintOutput = ESLintResult[] | { results: ESLintResult[] };

const isArrayFormat = (data: ESLintOutput): data is ESLintResult[] =>
  Array.isArray(data);

const extractEslintResults = (data: ESLintOutput): ESLintResult[] =>
  isArrayFormat(data) ? data : data.results;

const mapEslintSeverity = (
  severity: 0 | 1 | 2,
  fatal?: boolean
): "warning" | "error" => (fatal || severity === 2 ? "error" : "warning");

const extractEslintHints = (message: ESLintMessage): string[] | undefined => {
  if (!message.suggestions || message.suggestions.length === 0) {
    return undefined;
  }
  return message.suggestions
    .map((s) => s.desc)
    .filter((desc): desc is string => desc !== undefined);
};

export const parseEslint = (content: string): CIError[] => {
  let data: ESLintOutput;
  try {
    data = JSON.parse(content) as ESLintOutput;
  } catch {
    return [];
  }

  const results = extractEslintResults(data);
  if (!Array.isArray(results)) {
    return [];
  }

  const diagnostics: CIError[] = [];
  for (const result of results) {
    if (!Array.isArray(result.messages)) {
      continue;
    }
    for (const message of result.messages) {
      if (message.severity !== 0) {
        diagnostics.push({
          message: message.message,
          filePath: result.filePath,
          line: message.line,
          column: message.column,
          severity: mapEslintSeverity(message.severity, message.fatal),
          ruleId: message.ruleId ?? undefined,
          hints: extractEslintHints(message),
          fixable: message.fix !== undefined,
        });
      }
    }
  }
  return diagnostics;
};

// =============================================================================
// Vitest Parser
// =============================================================================

interface VitestLocation {
  line: number;
  column: number;
}

interface VitestAssertionResult {
  ancestorTitles?: string[];
  fullName?: string;
  status: "passed" | "failed" | "pending" | "todo" | "skipped";
  title: string;
  failureMessages?: string[];
  location?: VitestLocation;
}

interface VitestTestResult {
  assertionResults: VitestAssertionResult[];
  name: string;
}

interface VitestJsonOutput {
  success: boolean;
  testResults: VitestTestResult[];
}

const formatTestTitle = (assertion: VitestAssertionResult): string => {
  if (assertion.fullName) {
    return assertion.fullName.trim();
  }
  const ancestors = assertion.ancestorTitles?.filter(Boolean) ?? [];
  return [...ancestors, assertion.title].join(" > ");
};

export const parseVitest = (content: string): CIError[] => {
  let data: VitestJsonOutput;
  try {
    data = JSON.parse(content) as VitestJsonOutput;
  } catch {
    return [];
  }

  if (!Array.isArray(data.testResults) || data.testResults.length === 0) {
    return [];
  }

  const diagnostics: CIError[] = [];
  for (const result of data.testResults) {
    for (const assertion of result.assertionResults) {
      if (assertion.status === "failed" && assertion.failureMessages?.length) {
        const testTitle = formatTestTitle(assertion);
        const firstMessage = assertion.failureMessages[0] ?? "Test failed";

        diagnostics.push({
          message: `${testTitle}: ${firstMessage.split("\n")[0]}`,
          filePath: result.name,
          line: assertion.location?.line,
          column: assertion.location?.column,
          severity: "error",
          stackTrace: assertion.failureMessages.join("\n") || undefined,
        });
      }
    }
  }
  return diagnostics;
};

// =============================================================================
// TypeScript Parser (regex-based, no JSON reporter)
// =============================================================================

const TS_EXT_PATTERN = "(?:d\\.)?[cm]?tsx?";

const tsParenPattern = new RegExp(
  `^([^\\s(]+\\.${TS_EXT_PATTERN})\\((\\d+),(\\d+)\\):\\s*(?:(error|warning|fatal error)\\s+)?(TS\\d+)?:?\\s*(.+)$`,
  "i"
);

const tsColonPattern = new RegExp(
  `^([^\\s:]+\\.${TS_EXT_PATTERN}):(\\d+):(\\d+)\\s+-\\s+(error|warning|fatal error)\\s+(?:(TS\\d+):\\s*)?(.+)$`,
  "i"
);

// ANSI escape codes pattern for stripping terminal colors
const ANSI_PATTERN =
  /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

const stripAnsi = (str: string): string => str.replace(ANSI_PATTERN, "");

const mapTsSeverity = (severity: string | undefined): "error" | "warning" =>
  severity?.toLowerCase() === "warning" ? "warning" : "error";

const MAX_LINE_LENGTH = 2000;

export const parseTypeScript = (content: string): CIError[] => {
  const errors: CIError[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    if (line.length > MAX_LINE_LENGTH) {
      continue;
    }

    const stripped = stripAnsi(line.trim());
    if (!stripped) {
      continue;
    }

    let match = tsParenPattern.exec(stripped);
    if (match) {
      const [, filePath, lineStr, colStr, severity, ruleId, message] = match;
      if (filePath && lineStr && colStr && message) {
        errors.push({
          filePath,
          line: Number.parseInt(lineStr, 10),
          column: Number.parseInt(colStr, 10),
          severity: mapTsSeverity(severity),
          ruleId: ruleId || undefined,
          message: message.trim(),
        });
      }
      continue;
    }

    match = tsColonPattern.exec(stripped);
    if (match) {
      const [, filePath, lineStr, colStr, severity, ruleId, message] = match;
      if (filePath && lineStr && colStr && message) {
        errors.push({
          filePath,
          line: Number.parseInt(lineStr, 10),
          column: Number.parseInt(colStr, 10),
          severity: mapTsSeverity(severity),
          ruleId: ruleId || undefined,
          message: message.trim(),
        });
      }
    }
  }

  return errors;
};

// =============================================================================
// Cargo Parser (NDJSON)
// =============================================================================

interface CargoSpan {
  file_name: string;
  line_start: number;
  column_start: number;
  is_primary: boolean;
  label?: string | null;
  suggested_replacement?: string | null;
  suggestion_applicability?: string | null;
}

interface CargoCode {
  code: string;
}

interface CargoDiagnostic {
  message: string;
  level: string;
  code?: CargoCode | null;
  spans: CargoSpan[];
  children: CargoDiagnostic[];
  rendered?: string | null;
}

interface CargoCompilerMessage {
  reason: "compiler-message";
  message: CargoDiagnostic;
}

type CargoMessage = CargoCompilerMessage | { reason: string };

const findPrimarySpan = (spans: CargoSpan[]): CargoSpan | undefined =>
  spans.find((span) => span.is_primary);

const extractCargoHints = (children: CargoDiagnostic[]): string[] => {
  const hints: string[] = [];
  for (const child of children) {
    if (child.level === "help" && child.message) {
      const spanWithReplacement = child.spans.find(
        (s) => s.suggested_replacement != null
      );
      if (spanWithReplacement?.suggested_replacement) {
        hints.push(
          `${child.message}: \`${spanWithReplacement.suggested_replacement}\``
        );
      } else {
        hints.push(child.message);
      }
    } else if (child.level === "note" && child.message) {
      hints.push(`note: ${child.message}`);
    }
  }
  return hints;
};

const hasMachineApplicableFix = (
  spans: CargoSpan[],
  children: CargoDiagnostic[]
): boolean => {
  for (const span of spans) {
    if (
      span.suggestion_applicability === "MachineApplicable" ||
      span.suggestion_applicability === "MaybeIncorrect"
    ) {
      return true;
    }
  }
  for (const child of children) {
    for (const span of child.spans) {
      if (
        span.suggestion_applicability === "MachineApplicable" ||
        span.suggestion_applicability === "MaybeIncorrect"
      ) {
        return true;
      }
    }
  }
  return false;
};

const isCompilerMessage = (msg: CargoMessage): msg is CargoCompilerMessage =>
  msg.reason === "compiler-message" && "message" in msg;

export const parseCargo = (content: string): CIError[] => {
  const errors: CIError[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed?.startsWith("{")) {
      continue;
    }

    let parsed: CargoMessage;
    try {
      parsed = JSON.parse(trimmed) as CargoMessage;
    } catch {
      continue;
    }

    if (!isCompilerMessage(parsed)) {
      continue;
    }

    const diagnostic = parsed.message;
    if (diagnostic.level !== "error" && diagnostic.level !== "warning") {
      continue;
    }

    const primarySpan = findPrimarySpan(diagnostic.spans);
    const hints = extractCargoHints(diagnostic.children);
    const fixable = hasMachineApplicableFix(
      diagnostic.spans,
      diagnostic.children
    );

    let message = diagnostic.message;
    if (primarySpan?.label) {
      message = `${message}: ${primarySpan.label}`;
    }

    errors.push({
      message,
      filePath: primarySpan?.file_name,
      line: primarySpan?.line_start,
      column: primarySpan?.column_start,
      severity: diagnostic.level === "warning" ? "warning" : "error",
      ruleId: diagnostic.code?.code,
      stackTrace: diagnostic.rendered ?? undefined,
      hints: hints.length > 0 ? hints : undefined,
      fixable,
    });
  }

  return errors;
};

// =============================================================================
// golangci-lint Parser
// =============================================================================

interface GolangciPosition {
  Filename: string;
  Line: number;
  Column: number;
}

interface GolangciReplacement {
  NewLines?: string[];
  NeedOnlyDelete?: boolean;
}

interface GolangciSuggestedFix {
  Message?: string;
}

interface GolangciIssue {
  FromLinter: string;
  Text: string;
  Severity?: string;
  SourceLines?: string[];
  Pos: GolangciPosition;
  Replacement?: GolangciReplacement | null;
  SuggestedFixes?: GolangciSuggestedFix[];
}

interface GolangciOutput {
  Issues?: GolangciIssue[];
}

const extractGolangciHints = (
  replacement: GolangciReplacement | null | undefined,
  suggestedFixes: GolangciSuggestedFix[] | undefined
): string[] => {
  const hints: string[] = [];
  if (replacement?.NewLines && replacement.NewLines.length > 0) {
    hints.push(`Replace with: ${replacement.NewLines.join("\n")}`);
  } else if (replacement?.NeedOnlyDelete) {
    hints.push("Delete this code");
  }
  if (suggestedFixes) {
    for (const fix of suggestedFixes) {
      if (fix.Message) {
        hints.push(fix.Message);
      }
    }
  }
  return hints;
};

export const parseGolangci = (content: string): CIError[] => {
  let parsed: GolangciOutput;
  try {
    parsed = JSON.parse(content) as GolangciOutput;
  } catch {
    return [];
  }

  if (!Array.isArray(parsed.Issues)) {
    return [];
  }

  const errors: CIError[] = [];

  for (const issue of parsed.Issues) {
    if (!(issue.Pos?.Filename && issue.Text)) {
      continue;
    }

    const severity: "error" | "warning" =
      issue.Severity?.toLowerCase() === "warning" ? "warning" : "error";

    const hints = extractGolangciHints(issue.Replacement, issue.SuggestedFixes);
    const fixable =
      issue.Replacement != null ||
      (issue.SuggestedFixes != null && issue.SuggestedFixes.length > 0);

    errors.push({
      message: issue.Text,
      filePath: issue.Pos.Filename,
      line: issue.Pos.Line,
      column: issue.Pos.Column > 0 ? issue.Pos.Column : undefined,
      severity,
      ruleId: issue.FromLinter,
      fixable,
      hints: hints.length > 0 ? hints : undefined,
      stackTrace:
        issue.SourceLines && issue.SourceLines.length > 0
          ? issue.SourceLines.join("\n")
          : undefined,
    });
  }

  return errors;
};
