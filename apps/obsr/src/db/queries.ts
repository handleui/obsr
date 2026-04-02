import { desc, eq } from "drizzle-orm";
import type { IssueDiagnosticDraft } from "@/lib/issues/adapters/types";
import type { IssueObservationContext, IssuePlan } from "@/lib/issues/schema";
import { getDb } from "./client";
import { issueDiagnostics, issueObservations, issues } from "./schema";

interface CreateIssueShellInput {
  id: string;
  clusterKey: string;
  repo: string | null;
  app: string | null;
  service: string | null;
  environment: string;
  firstSeenAt: Date;
}

interface CreateIssueObservationInput {
  issueId: string;
  sourceKind: string;
  rawText: string | null;
  rawPayload: unknown;
  context: IssueObservationContext;
  capturedAt: Date;
  wasRedacted: boolean;
  wasTruncated: boolean;
}

interface UpdateIssueSnapshotInput {
  id: string;
  title: string;
  severity: string;
  status: string;
  primaryCategory: string | null;
  primarySourceKind: string | null;
  sourceKinds: string[];
  summary: string;
  rootCause: string | null;
  plan: IssuePlan;
  firstSeenAt: Date;
  lastSeenAt: Date;
  observationCount: number;
  diagnosticCount: number;
}

interface PersistIssueIngestInput {
  diagnostics: IssueDiagnosticDraft[];
  issueShell: CreateIssueShellInput | null;
  observation: CreateIssueObservationInput;
}

const buildIssueShellValues = (input: CreateIssueShellInput) => {
  return {
    id: input.id,
    title: "New issue",
    severity: "medium",
    status: "open",
    primaryCategory: null,
    primarySourceKind: null,
    sourceKinds: [],
    summary: "Issue pending synthesis.",
    rootCause: null,
    plan: {
      summary: "Issue pending synthesis.",
      steps: [],
      validation: [],
      blockers: [],
    },
    clusterKey: input.clusterKey,
    repo: input.repo,
    app: input.app,
    service: input.service,
    environment: input.environment,
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.firstSeenAt,
    observationCount: 0,
    diagnosticCount: 0,
    updatedAt: input.firstSeenAt,
  };
};

const buildObservationValues = (input: CreateIssueObservationInput) => {
  return {
    issueId: input.issueId,
    sourceKind: input.sourceKind,
    rawText: input.rawText,
    rawPayload: input.rawPayload,
    context: input.context,
    capturedAt: input.capturedAt,
    wasRedacted: input.wasRedacted,
    wasTruncated: input.wasTruncated,
  };
};

const buildDiagnosticValues = (
  issueId: string,
  observationId: string,
  diagnostics: IssueDiagnosticDraft[]
) => {
  return diagnostics.map((diagnostic) => ({
    issueId,
    observationId,
    fingerprint: diagnostic.fingerprint,
    repoFingerprint: diagnostic.repoFingerprint,
    loreFingerprint: diagnostic.loreFingerprint,
    message: diagnostic.message,
    severity: diagnostic.severity,
    category: diagnostic.category,
    source: diagnostic.source,
    filePath: diagnostic.filePath,
    line: diagnostic.line,
    column: diagnostic.column,
    ruleId: diagnostic.ruleId,
    evidence: diagnostic.evidence,
  }));
};

export const persistIssueIngest = (input: PersistIssueIngestInput) => {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    if (input.issueShell) {
      await tx.insert(issues).values(buildIssueShellValues(input.issueShell));
    }

    const [observation] = await tx
      .insert(issueObservations)
      .values(buildObservationValues(input.observation))
      .returning({
        id: issueObservations.id,
        issueId: issueObservations.issueId,
        sourceKind: issueObservations.sourceKind,
        rawText: issueObservations.rawText,
        rawPayload: issueObservations.rawPayload,
        context: issueObservations.context,
        capturedAt: issueObservations.capturedAt,
        wasRedacted: issueObservations.wasRedacted,
        wasTruncated: issueObservations.wasTruncated,
      });

    if (input.diagnostics.length > 0) {
      await tx
        .insert(issueDiagnostics)
        .values(
          buildDiagnosticValues(
            input.observation.issueId,
            observation.id,
            input.diagnostics
          )
        );
    }

    return observation;
  });
};

export const listIssueClusterCandidates = (clusterKey: string) => {
  const { db } = getDb();
  return db
    .select({
      id: issues.id,
      status: issues.status,
      lastSeenAt: issues.lastSeenAt,
    })
    .from(issues)
    .where(eq(issues.clusterKey, clusterKey))
    .orderBy(desc(issues.lastSeenAt));
};

export const listIssueClusterCandidateFingerprintRows = (
  clusterKey: string
) => {
  const { db } = getDb();
  return db
    .select({
      issueId: issueDiagnostics.issueId,
      repoFingerprint: issueDiagnostics.repoFingerprint,
      loreFingerprint: issueDiagnostics.loreFingerprint,
    })
    .from(issueDiagnostics)
    .innerJoin(issues, eq(issueDiagnostics.issueId, issues.id))
    .where(eq(issues.clusterKey, clusterKey));
};

export const updateIssueSnapshot = async (input: UpdateIssueSnapshotInput) => {
  const { db } = getDb();
  await db
    .update(issues)
    .set({
      title: input.title,
      severity: input.severity,
      status: input.status,
      primaryCategory: input.primaryCategory,
      primarySourceKind: input.primarySourceKind,
      sourceKinds: input.sourceKinds,
      summary: input.summary,
      rootCause: input.rootCause,
      plan: input.plan,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      observationCount: input.observationCount,
      diagnosticCount: input.diagnosticCount,
      updatedAt: new Date(),
    })
    .where(eq(issues.id, input.id));
};

export const listRecentIssues = (limit = 20) => {
  const { db } = getDb();
  return db
    .select({
      id: issues.id,
      title: issues.title,
      severity: issues.severity,
      status: issues.status,
      primaryCategory: issues.primaryCategory,
      primarySourceKind: issues.primarySourceKind,
      sourceKinds: issues.sourceKinds,
      summary: issues.summary,
      lastSeenAt: issues.lastSeenAt,
      observationCount: issues.observationCount,
      diagnosticCount: issues.diagnosticCount,
    })
    .from(issues)
    .orderBy(desc(issues.lastSeenAt))
    .limit(limit);
};

export const getIssueAggregateById = async (id: string) => {
  const { db } = getDb();

  const [issue] = await db
    .select({
      id: issues.id,
      title: issues.title,
      severity: issues.severity,
      status: issues.status,
      primaryCategory: issues.primaryCategory,
      primarySourceKind: issues.primarySourceKind,
      sourceKinds: issues.sourceKinds,
      summary: issues.summary,
      rootCause: issues.rootCause,
      plan: issues.plan,
      clusterKey: issues.clusterKey,
      repo: issues.repo,
      app: issues.app,
      service: issues.service,
      environment: issues.environment,
      firstSeenAt: issues.firstSeenAt,
      lastSeenAt: issues.lastSeenAt,
      observationCount: issues.observationCount,
      diagnosticCount: issues.diagnosticCount,
    })
    .from(issues)
    .where(eq(issues.id, id))
    .limit(1);

  if (!issue) {
    return null;
  }

  const observations = await db
    .select({
      id: issueObservations.id,
      issueId: issueObservations.issueId,
      sourceKind: issueObservations.sourceKind,
      rawText: issueObservations.rawText,
      rawPayload: issueObservations.rawPayload,
      context: issueObservations.context,
      capturedAt: issueObservations.capturedAt,
      wasRedacted: issueObservations.wasRedacted,
      wasTruncated: issueObservations.wasTruncated,
    })
    .from(issueObservations)
    .where(eq(issueObservations.issueId, id))
    .orderBy(desc(issueObservations.capturedAt));

  const diagnostics = await db
    .select({
      id: issueDiagnostics.id,
      issueId: issueDiagnostics.issueId,
      observationId: issueDiagnostics.observationId,
      fingerprint: issueDiagnostics.fingerprint,
      repoFingerprint: issueDiagnostics.repoFingerprint,
      loreFingerprint: issueDiagnostics.loreFingerprint,
      message: issueDiagnostics.message,
      severity: issueDiagnostics.severity,
      category: issueDiagnostics.category,
      source: issueDiagnostics.source,
      ruleId: issueDiagnostics.ruleId,
      filePath: issueDiagnostics.filePath,
      line: issueDiagnostics.line,
      column: issueDiagnostics.column,
      evidence: issueDiagnostics.evidence,
      createdAt: issueDiagnostics.createdAt,
    })
    .from(issueDiagnostics)
    .where(eq(issueDiagnostics.issueId, id))
    .orderBy(desc(issueDiagnostics.createdAt));

  return {
    issue,
    observations,
    diagnostics,
  };
};
