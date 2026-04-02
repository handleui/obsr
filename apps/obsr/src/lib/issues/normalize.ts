import { generateFingerprints } from "@obsr/lore";
import type { CIError, ErrorSource } from "@obsr/types";
import { scrubFilePath, scrubSecrets } from "@obsr/types";
import type {
  IssueDiagnosticDraft,
  IssueDiagnosticSeed,
} from "./adapters/types";
import { issueCategoryRank, MAX_EVIDENCE_CHARS } from "./constants";
import type {
  IssueCategory,
  IssueObservationContext,
  ObservationSourceKind,
} from "./schema";

const supportedIssueCategories = new Set<IssueCategory>([
  "type-check",
  "lint",
  "test",
  "compile",
  "runtime",
  "dependency",
  "config",
  "infrastructure",
  "security",
  "unknown",
]);

const supportedErrorSources = new Set<ErrorSource>([
  "biome",
  "eslint",
  "typescript",
  "go",
  "go-test",
  "python",
  "rust",
  "vitest",
  "docker",
  "nodejs",
  "metadata",
  "infrastructure",
  "github-annotations",
  "generic",
]);

const toNullableNumber = (value?: number | null) => {
  if (!value || value <= 0) {
    return null;
  }

  return value;
};

const toIssueCategory = (category?: string | null) => {
  if (!category) {
    return null;
  }

  if (supportedIssueCategories.has(category as IssueCategory)) {
    return category as IssueCategory;
  }

  return "unknown";
};

const truncateEvidence = (value: string) => {
  return value.slice(0, MAX_EVIDENCE_CHARS);
};

const toSnippetEvidence = (error: CIError) => {
  if (!error.codeSnippet) {
    return null;
  }

  const endLine =
    error.codeSnippet.startLine +
    Math.max(error.codeSnippet.lines.length - 1, 0);
  const snippet = error.codeSnippet.lines.map(scrubSecrets).join("\n").trim();
  return truncateEvidence(
    `Code ${error.codeSnippet.startLine}-${endLine}\n${snippet}`
  );
};

const toRawEvidence = (error: CIError) => {
  if (!error.raw?.trim()) {
    return null;
  }

  return truncateEvidence(scrubSecrets(error.raw));
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

const toFingerprintSource = (source?: string | null) => {
  if (!(source && supportedErrorSources.has(source as ErrorSource))) {
    return undefined;
  }

  return source as ErrorSource;
};

export const buildEvidenceFromCiError = (error: CIError) => {
  return (
    toSnippetEvidence(error) ??
    toRawEvidence(error) ??
    toLogReference(error) ??
    truncateEvidence(scrubSecrets(error.message))
  );
};

export const createIssueDiagnosticDraft = (
  seed: IssueDiagnosticSeed
): IssueDiagnosticDraft => {
  const message = scrubSecrets(seed.message);
  const source = seed.source?.trim() || null;
  const ruleId = seed.ruleId?.trim() || null;
  const filePath = scrubFilePath(seed.filePath ?? undefined) ?? null;
  const line = toNullableNumber(seed.line);
  const column = toNullableNumber(seed.column);
  const evidence = truncateEvidence(
    scrubSecrets(seed.evidence?.trim() || message)
  );
  const fingerprints = generateFingerprints({
    message,
    source: toFingerprintSource(source),
    ruleId: ruleId ?? undefined,
    filePath: filePath ?? undefined,
    line: line ?? undefined,
    column: column ?? undefined,
  });

  return {
    fingerprint: fingerprints.instance,
    repoFingerprint: fingerprints.repo,
    loreFingerprint: fingerprints.lore,
    message,
    severity: seed.severity ?? null,
    category: toIssueCategory(seed.category ?? null),
    source,
    ruleId,
    filePath,
    line,
    column,
    evidence,
  };
};

export const mapCiErrorToIssueDiagnostic = (
  error: CIError,
  detectedSource: ErrorSource | null
) => {
  return createIssueDiagnosticDraft({
    message: error.message,
    severity: error.severity ?? null,
    category: error.category ?? null,
    source: error.source ?? detectedSource ?? null,
    ruleId: error.ruleId ?? null,
    filePath: error.filePath ?? null,
    line: error.line ?? null,
    column: error.column ?? null,
    evidence: buildEvidenceFromCiError(error),
  });
};

export const dedupeIssueDiagnostics = (diagnostics: IssueDiagnosticDraft[]) => {
  const unique = new Map<string, IssueDiagnosticDraft>();

  for (const diagnostic of diagnostics) {
    if (!unique.has(diagnostic.fingerprint)) {
      unique.set(diagnostic.fingerprint, diagnostic);
    }
  }

  return [...unique.values()];
};

const getSeverityScore = (severity: IssueDiagnosticDraft["severity"]) => {
  return severity === "error" ? 0 : 1;
};

const getCategoryScore = (category: IssueDiagnosticDraft["category"]) => {
  return issueCategoryRank.get(category ?? "unknown") ?? issueCategoryRank.size;
};

const getLocationScore = (diagnostic: IssueDiagnosticDraft) => {
  return diagnostic.filePath || diagnostic.ruleId || diagnostic.line ? 0 : 1;
};

export const rankIssueDiagnostics = (diagnostics: IssueDiagnosticDraft[]) => {
  return [...diagnostics].sort((left, right) => {
    return (
      getSeverityScore(left.severity) - getSeverityScore(right.severity) ||
      getCategoryScore(left.category) - getCategoryScore(right.category) ||
      getLocationScore(left) - getLocationScore(right)
    );
  });
};

export const scrubUnknown = (value: unknown): unknown => {
  if (typeof value === "string") {
    return scrubSecrets(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubUnknown(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubUnknown(entry)])
    );
  }

  return value;
};

const normalizeClusterPart = (value?: string) => {
  if (!value?.trim()) {
    return "_";
  }

  return value.trim().toLowerCase();
};

export const buildClusterKey = (context: IssueObservationContext) => {
  return [
    normalizeClusterPart(context.repo),
    normalizeClusterPart(context.app),
    normalizeClusterPart(context.service),
    normalizeClusterPart(context.environment),
  ].join("::");
};

export const normalizeSourceKinds = (sourceKinds: ObservationSourceKind[]) => {
  return [...new Set(sourceKinds)].sort();
};
