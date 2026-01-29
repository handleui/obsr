import type { Diagnostic } from "../types.js";

interface ESLintSuggestion {
  desc?: string;
  messageId?: string;
  fix?: {
    range: [number, number];
    text: string;
  };
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
  endLine?: number;
  endColumn?: number;
  messageId?: string;
  fatal?: boolean;
  fix?: ESLintFix;
  suggestions?: ESLintSuggestion[];
}

interface ESLintResult {
  filePath: string;
  messages: ESLintMessage[];
  errorCount?: number;
  warningCount?: number;
}

type ESLintOutput = ESLintResult[] | { results: ESLintResult[] };

const isArrayFormat = (data: ESLintOutput): data is ESLintResult[] =>
  Array.isArray(data);

const extractResults = (data: ESLintOutput): ESLintResult[] =>
  isArrayFormat(data) ? data : data.results;

const mapSeverity = (
  severity: 0 | 1 | 2,
  fatal?: boolean
): "warning" | "error" => (fatal || severity === 2 ? "error" : "warning");

const extractHints = (message: ESLintMessage): string[] | undefined => {
  if (!message.suggestions || message.suggestions.length === 0) {
    return undefined;
  }
  return message.suggestions
    .map((s) => s.desc)
    .filter((desc): desc is string => desc !== undefined);
};

const parseMessage = (
  filePath: string,
  message: ESLintMessage
): Diagnostic => ({
  message: message.message,
  filePath,
  line: message.line,
  column: message.column,
  severity: mapSeverity(message.severity, message.fatal),
  ruleId: message.ruleId ?? undefined,
  hints: extractHints(message),
  fixable: message.fix !== undefined,
});

export const parseEslint = (content: string): Diagnostic[] => {
  let data: ESLintOutput;
  try {
    data = JSON.parse(content) as ESLintOutput;
  } catch {
    return [];
  }

  const results = extractResults(data);
  if (!Array.isArray(results)) {
    return [];
  }

  // Direct iteration avoids intermediate arrays from flatMap/filter/map
  const diagnostics: Diagnostic[] = [];
  for (const result of results) {
    if (!Array.isArray(result.messages)) {
      continue;
    }
    for (const message of result.messages) {
      if (message.severity !== 0) {
        diagnostics.push(parseMessage(result.filePath, message));
      }
    }
  }
  return diagnostics;
};
