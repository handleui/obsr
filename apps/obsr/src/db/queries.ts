import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "./client";
import { analyses, analysisDiagnostics } from "./schema";

interface InsertAnalysisInput {
  inputKind: string;
  rawLog: string;
  rawLogWasTruncated: boolean;
  summary: string;
}

interface InsertDiagnosticInput {
  fingerprint: string;
  message: string;
  severity: string | null;
  category: string | null;
  source: string | null;
  filePath: string | null;
  line: number | null;
  column: number | null;
  ruleId: string | null;
  evidence: string;
  rank: number;
}

export const createAnalysisRecord = (
  input: InsertAnalysisInput,
  diagnostics: InsertDiagnosticInput[]
) => {
  const { db } = getDb();

  return db.transaction(async (tx) => {
    const createdAt = new Date();
    const [analysis] = await tx
      .insert(analyses)
      .values({
        createdAt,
        inputKind: input.inputKind,
        rawLog: input.rawLog,
        rawLogWasTruncated: input.rawLogWasTruncated,
        summary: input.summary,
      })
      .returning({
        id: analyses.id,
        createdAt: analyses.createdAt,
        inputKind: analyses.inputKind,
        rawLogWasTruncated: analyses.rawLogWasTruncated,
        summary: analyses.summary,
      });

    if (diagnostics.length > 0) {
      await tx.insert(analysisDiagnostics).values(
        diagnostics.map((diagnostic) => ({
          analysisId: analysis.id,
          ...diagnostic,
        }))
      );
    }

    return analysis;
  });
};

export const listRecentAnalyses = (limit = 20) => {
  const { db } = getDb();
  return db
    .select({
      id: analyses.id,
      createdAt: analyses.createdAt,
      inputKind: analyses.inputKind,
      summary: analyses.summary,
      diagnosticCount: sql<number>`(
        select count(*)::int
        from ${analysisDiagnostics}
        where ${analysisDiagnostics.analysisId} = ${analyses.id}
      )`,
    })
    .from(analyses)
    .orderBy(desc(analyses.createdAt))
    .limit(limit);
};

export const getAnalysisRecordById = async (id: string) => {
  const { db } = getDb();

  const [analysis] = await db
    .select({
      id: analyses.id,
      createdAt: analyses.createdAt,
      inputKind: analyses.inputKind,
      rawLogWasTruncated: analyses.rawLogWasTruncated,
      summary: analyses.summary,
    })
    .from(analyses)
    .where(eq(analyses.id, id))
    .limit(1);

  if (!analysis) {
    return null;
  }

  const diagnostics = await db
    .select({
      fingerprint: analysisDiagnostics.fingerprint,
      message: analysisDiagnostics.message,
      severity: analysisDiagnostics.severity,
      category: analysisDiagnostics.category,
      source: analysisDiagnostics.source,
      filePath: analysisDiagnostics.filePath,
      line: analysisDiagnostics.line,
      column: analysisDiagnostics.column,
      ruleId: analysisDiagnostics.ruleId,
      evidence: analysisDiagnostics.evidence,
      rank: analysisDiagnostics.rank,
    })
    .from(analysisDiagnostics)
    .where(eq(analysisDiagnostics.analysisId, id))
    .orderBy(analysisDiagnostics.rank);

  return {
    ...analysis,
    diagnostics,
  };
};
