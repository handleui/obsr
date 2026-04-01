import { generateFingerprints } from "@obsr/lore";
import {
  type CIErrorSchema,
  type ErrorSourceSchema,
  scrubFilePath,
  scrubSecrets,
} from "@obsr/types";
import type { z } from "zod";
import type { AnalysisDiagnostic } from "@/lib/contracts";
import { categoryRank, MAX_EVIDENCE_CHARS } from "./constants";

type CIError = z.infer<typeof CIErrorSchema>;
type ErrorSource = z.infer<typeof ErrorSourceSchema>;

const toNullableNumber = (value?: number | null) => {
  if (!value || value <= 0) {
    return null;
  }
  return value;
};

const toSnippetEvidence = (error: CIError) => {
  if (!error.codeSnippet) {
    return null;
  }

  const endLine =
    error.codeSnippet.startLine +
    Math.max(error.codeSnippet.lines.length - 1, 0);
  const snippet = error.codeSnippet.lines.map(scrubSecrets).join("\n").trim();
  return `Code ${error.codeSnippet.startLine}-${endLine}\n${snippet}`.slice(
    0,
    MAX_EVIDENCE_CHARS
  );
};

const toRawEvidence = (error: CIError) => {
  if (!error.raw?.trim()) {
    return null;
  }
  return scrubSecrets(error.raw).slice(0, MAX_EVIDENCE_CHARS);
};

const toLogReference = (error: CIError) => {
  if (!error.logLineStart) {
    return null;
  }

  if (error.logLineEnd && error.logLineEnd > error.logLineStart) {
    return `Log lines ${error.logLineStart}-${error.logLineEnd}`;
  }

  return `Log line ${error.logLineStart}`;
};

export const buildEvidence = (error: CIError) => {
  return (
    toSnippetEvidence(error) ??
    toRawEvidence(error) ??
    toLogReference(error) ??
    scrubSecrets(error.message).slice(0, MAX_EVIDENCE_CHARS)
  );
};

export const mapExtractedDiagnostics = (
  errors: CIError[],
  detectedSource: ErrorSource | null
): AnalysisDiagnostic[] => {
  return errors.map((error) => {
    const fingerprints = generateFingerprints({
      ...error,
      source: error.source ?? detectedSource ?? undefined,
    });

    return {
      fingerprint: fingerprints.instance,
      message: scrubSecrets(error.message),
      severity: error.severity ?? null,
      category: error.category ?? null,
      source: error.source ?? detectedSource ?? null,
      filePath: scrubFilePath(error.filePath) ?? null,
      line: toNullableNumber(error.line),
      column: toNullableNumber(error.column),
      ruleId: error.ruleId ?? null,
      evidence: buildEvidence(error),
      rank: 0,
    };
  });
};

export const dedupeDiagnostics = (diagnostics: AnalysisDiagnostic[]) => {
  const unique = new Map<string, AnalysisDiagnostic>();
  for (const diagnostic of diagnostics) {
    if (!unique.has(diagnostic.fingerprint)) {
      unique.set(diagnostic.fingerprint, diagnostic);
    }
  }
  return [...unique.values()];
};

const getSeverityScore = (severity: AnalysisDiagnostic["severity"]) => {
  return severity === "error" ? 0 : 1;
};

const getCategoryScore = (category: AnalysisDiagnostic["category"]) => {
  return categoryRank.get(category ?? "unknown") ?? categoryRank.size;
};

const getLocationScore = (diagnostic: AnalysisDiagnostic) => {
  return diagnostic.filePath || diagnostic.ruleId || diagnostic.line ? 0 : 1;
};

export const rankDiagnostics = (diagnostics: AnalysisDiagnostic[]) => {
  const ranked = [...diagnostics].sort((left, right) => {
    return (
      getSeverityScore(left.severity) - getSeverityScore(right.severity) ||
      getCategoryScore(left.category) - getCategoryScore(right.category) ||
      getLocationScore(left) - getLocationScore(right)
    );
  });

  return ranked.map((diagnostic, index) => ({
    ...diagnostic,
    rank: index,
  }));
};
