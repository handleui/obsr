import type { AnalysisDiagnostic } from "@/lib/contracts";
import { MAX_PROMPT_CHARS, MAX_PROMPT_DIAGNOSTICS } from "./constants";

const MAX_PROMPT_LINE_CHARS = 240;
const MAX_PROMPT_SUMMARY_CHARS = 360;
const PROMPT_TRUNCATION_SUFFIX = "...";

const truncateText = (value: string, maxChars: number) => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - PROMPT_TRUNCATION_SUFFIX.length).trimEnd()}${PROMPT_TRUNCATION_SUFFIX}`;
};

const formatLocation = (diagnostic: AnalysisDiagnostic) => {
  if (!diagnostic.filePath) {
    return null;
  }

  const line = diagnostic.line ? `:${diagnostic.line}` : "";
  const column = diagnostic.column ? `:${diagnostic.column}` : "";
  return `${diagnostic.filePath}${line}${column}`;
};

const formatDiagnostic = (diagnostic: AnalysisDiagnostic, index: number) => {
  const meta = [
    diagnostic.source,
    diagnostic.ruleId,
    formatLocation(diagnostic),
  ].filter(Boolean);

  return truncateText(
    `${index + 1}. ${meta.length ? `[${meta.join(" | ")}] ` : ""}${diagnostic.message}`,
    MAX_PROMPT_LINE_CHARS
  );
};

export const buildAnalysisPrompt = ({
  summary,
  diagnostics,
}: {
  summary: string;
  diagnostics: AnalysisDiagnostic[];
}) => {
  const lines = [
    "CI summary:",
    truncateText(summary, MAX_PROMPT_SUMMARY_CHARS),
    "",
    "Fix first:",
    ...diagnostics
      .slice(0, MAX_PROMPT_DIAGNOSTICS)
      .map((diagnostic, index) => formatDiagnostic(diagnostic, index)),
    "",
    "Please explain root cause, what to fix first, and the smallest safe patch.",
  ];

  const prompt = lines.join("\n");
  if (prompt.length <= MAX_PROMPT_CHARS) {
    return prompt;
  }

  return `${prompt.slice(0, MAX_PROMPT_CHARS - 24).trimEnd()}\n[truncated for brevity]`;
};
