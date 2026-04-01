import { createGateway } from "@ai-sdk/gateway";
import { DEFAULT_FAST_MODEL, DEFAULT_TIMEOUT_MS } from "@obsr/ai";
import { generateText, Output } from "ai";
import { z } from "zod";
import type { AnalysisDiagnostic } from "@/lib/contracts";
import { getAiGatewayApiKey } from "@/lib/env";

const SummarySchema = z.object({
  summary: z.string().min(1).max(280),
});

const SUMMARY_OUTPUT = Output.object({
  schema: SummarySchema,
});

const buildSummaryPrompt = (diagnostics: AnalysisDiagnostic[]) => {
  const topDiagnostics = diagnostics.slice(0, 8).map((diagnostic) => ({
    message: diagnostic.message,
    severity: diagnostic.severity,
    category: diagnostic.category,
    source: diagnostic.source,
    filePath: diagnostic.filePath,
    line: diagnostic.line,
    ruleId: diagnostic.ruleId,
  }));

  return `Summarize these CI diagnostics in 2 short sentences. Mention what failed first and the most actionable fix area.\n\n${JSON.stringify(
    topDiagnostics,
    null,
    2
  )}`;
};

export const buildFallbackSummary = (diagnostics: AnalysisDiagnostic[]) => {
  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  ).length;
  const warningCount = diagnostics.length - errorCount;
  const primary = diagnostics[0];
  const location = primary?.filePath
    ? ` in ${primary.filePath}${primary.line ? `:${primary.line}` : ""}`
    : "";

  if (!primary) {
    return "No actionable diagnostics were extracted.";
  }

  return `${errorCount} error${errorCount === 1 ? "" : "s"} and ${warningCount} warning${warningCount === 1 ? "" : "s"} found. Start with ${primary.source ?? primary.category ?? "the primary failure"}${location}.`;
};

const generateSummaryText = async (diagnostics: AnalysisDiagnostic[]) => {
  const gateway = createGateway({
    apiKey: getAiGatewayApiKey(),
  });

  const result = await generateText({
    model: gateway(DEFAULT_FAST_MODEL),
    abortSignal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    system:
      "You summarize CI diagnostics for engineers. Be concise, plain-language, and action-first.",
    prompt: buildSummaryPrompt(diagnostics),
    output: SUMMARY_OUTPUT,
    maxOutputTokens: 180,
  });

  return result.output?.summary?.trim() ?? "";
};

export const summarizeDiagnostics = async (
  diagnostics: AnalysisDiagnostic[],
  options?: {
    generateSummary?: (diagnostics: AnalysisDiagnostic[]) => Promise<string>;
  }
) => {
  const fallback = buildFallbackSummary(diagnostics);
  const generateSummary = options?.generateSummary ?? generateSummaryText;

  try {
    const summary = await generateSummary(diagnostics);
    return summary || fallback;
  } catch {
    return fallback;
  }
};
