import {
  getIssueAggregateById,
  listIssueClusterCandidateFingerprintRows,
  listIssueClusterCandidates,
  listRecentIssues,
  persistIssueIngest,
  updateIssueSnapshot,
} from "@/db/queries";
import { RouteError } from "@/lib/http";
import { sentryIssueAdapter } from "./adapters/sentry";
import { textLogIssueAdapter } from "./adapters/text-log";
import { buildIssueBrief } from "./brief";
import { selectIssueClusterMatch } from "./cluster";
import { issueCategoryRank } from "./constants";
import { buildClusterKey } from "./normalize";
import type {
  IssueCreated,
  IssueDetail,
  IssueDetailView,
  IssueDiagnostic,
  IssueIngestInput,
  IssueIngestOutput,
  IssueListItem,
  IssueObservation,
} from "./schema";
import {
  IssueCreatedSchema,
  IssueDetailSchema,
  IssueDetailViewSchema,
  IssueIngestOutputSchema,
  IssueListItemSchema,
} from "./schema";
import { synthesizeIssueSnapshot } from "./synthesize";

const issueAdapters = [textLogIssueAdapter, sentryIssueAdapter];

const serializeDate = (date: Date) => {
  return date.toISOString();
};

const getIssueAdapter = (sourceKind: IssueIngestInput["sourceKind"]) => {
  const adapter = issueAdapters.find((candidate) =>
    candidate.sourceKinds.includes(sourceKind)
  );

  if (!adapter) {
    throw new RouteError(
      400,
      "UNSUPPORTED_SOURCE_KIND",
      `Unsupported source kind: ${sourceKind}`
    );
  }

  return adapter;
};

const getSeverityScore = (severity: IssueDiagnostic["severity"]) => {
  return severity === "error" ? 0 : 1;
};

const getCategoryScore = (category: IssueDiagnostic["category"]) => {
  return issueCategoryRank.get(category ?? "unknown") ?? issueCategoryRank.size;
};

const getLocationScore = (
  diagnostic: Pick<IssueDiagnostic, "filePath" | "ruleId" | "line">
) => {
  return diagnostic.filePath || diagnostic.ruleId || diagnostic.line ? 0 : 1;
};

const rankIssueDiagnosticsForOutput = (diagnostics: IssueDiagnostic[]) => {
  return [...diagnostics].sort((left, right) => {
    return (
      getSeverityScore(left.severity) - getSeverityScore(right.severity) ||
      getCategoryScore(left.category) - getCategoryScore(right.category) ||
      getLocationScore(left) - getLocationScore(right)
    );
  });
};

const toIssueObservation = (record: {
  id: string;
  issueId: string;
  sourceKind: string;
  rawText: string | null;
  rawPayload: unknown;
  context: unknown;
  capturedAt: Date;
  wasRedacted: boolean;
  wasTruncated: boolean;
}): IssueObservation => {
  return {
    id: record.id,
    issueId: record.issueId,
    sourceKind: record.sourceKind as IssueObservation["sourceKind"],
    rawText: record.rawText ?? undefined,
    rawPayload: record.rawPayload ?? undefined,
    context: record.context as IssueObservation["context"],
    capturedAt: serializeDate(record.capturedAt),
    wasRedacted: record.wasRedacted,
    wasTruncated: record.wasTruncated,
  };
};

const toIssueDiagnostic = (record: {
  id: string;
  issueId: string;
  observationId: string;
  fingerprint: string;
  message: string;
  severity: string | null;
  category: string | null;
  source: string | null;
  ruleId: string | null;
  filePath: string | null;
  line: number | null;
  column: number | null;
  evidence: string;
}): IssueDiagnostic => {
  return {
    id: record.id,
    issueId: record.issueId,
    observationId: record.observationId,
    fingerprint: record.fingerprint,
    message: record.message,
    severity: record.severity as IssueDiagnostic["severity"],
    category: record.category as IssueDiagnostic["category"],
    source: record.source,
    ruleId: record.ruleId,
    filePath: record.filePath,
    line: record.line,
    column: record.column,
    evidence: record.evidence,
  };
};

const toIssueDetail = (
  aggregate: NonNullable<Awaited<ReturnType<typeof getIssueAggregateById>>>
): IssueDetail => {
  const issue = IssueDetailSchema.omit({ brief: true }).parse({
    id: aggregate.issue.id,
    title: aggregate.issue.title,
    severity: aggregate.issue.severity,
    status: aggregate.issue.status,
    primaryCategory: aggregate.issue.primaryCategory,
    primarySourceKind: aggregate.issue.primarySourceKind,
    sourceKinds: aggregate.issue.sourceKinds,
    summary: aggregate.issue.summary,
    rootCause: aggregate.issue.rootCause,
    plan: aggregate.issue.plan,
    firstSeenAt: serializeDate(aggregate.issue.firstSeenAt),
    lastSeenAt: serializeDate(aggregate.issue.lastSeenAt),
    observationCount: aggregate.issue.observationCount,
    diagnosticCount: aggregate.issue.diagnosticCount,
    observations: aggregate.observations.map(toIssueObservation),
    diagnostics: rankIssueDiagnosticsForOutput(
      aggregate.diagnostics.map((diagnostic) => toIssueDiagnostic(diagnostic))
    ),
  });

  return IssueDetailSchema.parse({
    ...issue,
    brief: buildIssueBrief(issue),
  });
};

const toIssueDetailView = (issue: IssueDetail): IssueDetailView => {
  return IssueDetailViewSchema.parse({
    ...issue,
    observations: issue.observations.map((observation) => ({
      id: observation.id,
      issueId: observation.issueId,
      sourceKind: observation.sourceKind,
      context: observation.context,
      capturedAt: observation.capturedAt,
      wasRedacted: observation.wasRedacted,
      wasTruncated: observation.wasTruncated,
    })),
  });
};

export const toIssueCreated = (
  issue: Pick<IssueDetail, "id">
): IssueCreated => {
  return IssueCreatedSchema.parse({
    id: issue.id,
  });
};

const groupFingerprintRowsByIssue = (
  fingerprintRows: Array<{
    issueId: string;
    repoFingerprint: string;
    loreFingerprint: string;
  }>
) => {
  const grouped = new Map<
    string,
    {
      loreFingerprints: string[];
      repoFingerprints: string[];
    }
  >();

  for (const row of fingerprintRows) {
    const fingerprints = grouped.get(row.issueId) ?? {
      loreFingerprints: [],
      repoFingerprints: [],
    };

    fingerprints.repoFingerprints.push(row.repoFingerprint);
    fingerprints.loreFingerprints.push(row.loreFingerprint);
    grouped.set(row.issueId, fingerprints);
  }

  return grouped;
};

export const ingestIssue = async (
  input: IssueIngestInput
): Promise<IssueIngestOutput> => {
  const adapter = getIssueAdapter(input.sourceKind);
  const normalized = await adapter.normalize(input);
  const clusterKey = buildClusterKey(normalized.context);
  const [candidates, fingerprintRows] = await Promise.all([
    listIssueClusterCandidates(clusterKey),
    listIssueClusterCandidateFingerprintRows(clusterKey),
  ]);
  const fingerprintsByIssue = groupFingerprintRowsByIssue(fingerprintRows);
  const issueId =
    selectIssueClusterMatch({
      candidates: candidates.map((candidate) => ({
        issueId: candidate.id,
        status: candidate.status as IssueDetail["status"],
        lastSeenAt: candidate.lastSeenAt,
        repoFingerprints:
          fingerprintsByIssue.get(candidate.id)?.repoFingerprints ?? [],
        loreFingerprints:
          fingerprintsByIssue.get(candidate.id)?.loreFingerprints ?? [],
      })),
      diagnostics: normalized.diagnostics,
    }) ?? crypto.randomUUID();

  await persistIssueIngest({
    diagnostics: normalized.diagnostics,
    issueShell: candidates.some((candidate) => candidate.id === issueId)
      ? null
      : {
          id: issueId,
          clusterKey,
          repo: normalized.context.repo ?? null,
          app: normalized.context.app ?? null,
          service: normalized.context.service ?? null,
          environment: normalized.context.environment,
          firstSeenAt: normalized.capturedAt,
        },
    observation: {
      issueId,
      sourceKind: normalized.sourceKind,
      rawText: normalized.rawText ?? null,
      rawPayload: normalized.rawPayload ?? null,
      context: normalized.context,
      capturedAt: normalized.capturedAt,
      wasRedacted: normalized.wasRedacted,
      wasTruncated: normalized.wasTruncated,
    },
  });

  const aggregate = await getIssueAggregateById(issueId);
  if (!aggregate) {
    throw new RouteError(500, "INTERNAL_ERROR", "Issue aggregation failed.");
  }

  const synthesized = await synthesizeIssueSnapshot({
    diagnostics: aggregate.diagnostics.map((diagnostic) => ({
      fingerprint: diagnostic.fingerprint,
      repoFingerprint: diagnostic.repoFingerprint,
      loreFingerprint: diagnostic.loreFingerprint,
      message: diagnostic.message,
      severity: diagnostic.severity as IssueDiagnostic["severity"],
      category: diagnostic.category as IssueDiagnostic["category"],
      source: diagnostic.source,
      ruleId: diagnostic.ruleId,
      filePath: diagnostic.filePath,
      line: diagnostic.line,
      column: diagnostic.column,
      evidence: diagnostic.evidence,
    })),
    observations: aggregate.observations.map(toIssueObservation),
  });

  await updateIssueSnapshot({
    id: issueId,
    title: synthesized.title,
    severity: synthesized.severity,
    status: synthesized.status,
    primaryCategory: synthesized.primaryCategory,
    primarySourceKind: synthesized.primarySourceKind,
    sourceKinds: synthesized.sourceKinds,
    summary: synthesized.summary,
    rootCause: synthesized.rootCause,
    plan: synthesized.plan,
    firstSeenAt: aggregate.observations.reduce(
      (earliest, observation) =>
        observation.capturedAt < earliest ? observation.capturedAt : earliest,
      aggregate.observations[0]?.capturedAt ?? normalized.capturedAt
    ),
    lastSeenAt: aggregate.observations.reduce(
      (latest, observation) =>
        observation.capturedAt > latest ? observation.capturedAt : latest,
      aggregate.observations[0]?.capturedAt ?? normalized.capturedAt
    ),
    observationCount: aggregate.observations.length,
    diagnosticCount: aggregate.diagnostics.length,
  });

  const refreshedAggregate = await getIssueAggregateById(issueId);
  if (!refreshedAggregate) {
    throw new RouteError(500, "INTERNAL_ERROR", "Issue refresh failed.");
  }

  return IssueIngestOutputSchema.parse(toIssueDetail(refreshedAggregate));
};

export const getIssueDetail = async (id: string): Promise<IssueDetail> => {
  const aggregate = await getIssueAggregateById(id);
  if (!aggregate) {
    throw new RouteError(404, "NOT_FOUND", "Issue not found.");
  }

  return toIssueDetail(aggregate);
};

export const getIssueDetailView = async (
  id: string
): Promise<IssueDetailView> => {
  return toIssueDetailView(await getIssueDetail(id));
};

export const listIssues = async (): Promise<IssueListItem[]> => {
  const records = await listRecentIssues();
  return records.map((record) =>
    IssueListItemSchema.parse({
      id: record.id,
      title: record.title,
      severity: record.severity,
      status: record.status,
      primaryCategory: record.primaryCategory,
      primarySourceKind: record.primarySourceKind,
      sourceKinds: record.sourceKinds,
      summary: record.summary,
      lastSeenAt: serializeDate(record.lastSeenAt),
      observationCount: record.observationCount,
      diagnosticCount: record.diagnosticCount,
    })
  );
};
