import { scrubFilePath, scrubSecrets } from "@obsr/types";
import { generateFingerprints } from "./fingerprint.js";
import type {
  IssueCategory,
  IssueDiagnosticDraft,
  IssueDiagnosticSeed,
  IssueObservationContext,
  IssueObservationMemory,
  ObservationSourceKind,
  RelatedIssueMemory,
} from "./schema.js";
import {
  IssueObservationContextSchema,
  RelatedIssueMemorySchema,
} from "./schema.js";

const MAX_MESSAGE_CHARS = 500;
const MAX_EVIDENCE_CHARS = 500;
const MAX_CONTEXT_VALUE_CHARS = 160;
const MAX_COMMAND_CHARS = 240;
const MAX_RELATED_TITLE_CHARS = 120;
const MAX_RELATED_SUMMARY_CHARS = 320;
const MAX_RELATED_MATCH_REASON_CHARS = 180;

export const issueCategoryRank = new Map(
  [
    "security",
    "infrastructure",
    "config",
    "dependency",
    "compile",
    "type-check",
    "test",
    "runtime",
    "lint",
    "unknown",
  ].map((category, index) => [category, index])
);

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

const sanitizeText = (
  value: string | null | undefined,
  maxChars: number,
  scrubPath = false
) => {
  if (!value?.trim()) {
    return undefined;
  }

  const secretScrubbed = scrubSecrets(value.trim());
  const pathScrubbed = scrubPath
    ? (scrubFilePath(secretScrubbed) ?? secretScrubbed)
    : secretScrubbed;

  return pathScrubbed.slice(0, maxChars);
};

export const createIssueDiagnosticDraft = (
  seed: IssueDiagnosticSeed
): IssueDiagnosticDraft => {
  const message =
    sanitizeText(seed.message, MAX_MESSAGE_CHARS) ?? "Unknown issue";
  const source = sanitizeText(seed.source, 80) ?? null;
  const ruleId = sanitizeText(seed.ruleId, 120) ?? null;
  const filePath = sanitizeText(seed.filePath, 240, true) ?? null;
  const line = toNullableNumber(seed.line);
  const column = toNullableNumber(seed.column);
  const evidence = truncateEvidence(
    scrubSecrets(seed.evidence?.trim() || message)
  );
  const fingerprints = generateFingerprints({
    message,
    source: source ?? undefined,
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

export const sanitizeIssueObservationContext = (
  context: IssueObservationContext
): IssueObservationContext => {
  return IssueObservationContextSchema.parse({
    repo: sanitizeText(context.repo, MAX_CONTEXT_VALUE_CHARS),
    app: sanitizeText(context.app, MAX_CONTEXT_VALUE_CHARS),
    service: sanitizeText(context.service, MAX_CONTEXT_VALUE_CHARS),
    environment: context.environment,
    branch: sanitizeText(context.branch, MAX_CONTEXT_VALUE_CHARS, true),
    commitSha: sanitizeText(context.commitSha, MAX_CONTEXT_VALUE_CHARS),
    command: sanitizeText(context.command, MAX_COMMAND_CHARS, true),
    route: sanitizeText(context.route, MAX_COMMAND_CHARS),
    provider: sanitizeText(context.provider, MAX_CONTEXT_VALUE_CHARS),
    externalId: sanitizeText(context.externalId, MAX_CONTEXT_VALUE_CHARS),
    externalUrl: sanitizeText(context.externalUrl, 500),
  });
};

export const sanitizeIssueObservationMemory = (
  observation: IssueObservationMemory
): IssueObservationMemory => {
  return {
    sourceKind: observation.sourceKind,
    context: sanitizeIssueObservationContext(observation.context),
  };
};

export const sanitizeRelatedIssueMemory = (
  issue: RelatedIssueMemory
): RelatedIssueMemory => {
  return RelatedIssueMemorySchema.parse({
    title:
      sanitizeText(issue.title, MAX_RELATED_TITLE_CHARS) ?? "Related issue",
    summary:
      sanitizeText(issue.summary, MAX_RELATED_SUMMARY_CHARS) ??
      "Summary unavailable.",
    matchReason:
      sanitizeText(issue.matchReason, MAX_RELATED_MATCH_REASON_CHARS) ??
      "Related by shared evidence.",
    status: issue.status,
    severity: issue.severity,
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
