import { extractErrors } from "@obsr/extract";
import { scrubSecrets } from "@obsr/types";
import {
  createAnalysisRecord,
  getAnalysisRecordById,
  listRecentAnalyses,
} from "@/db/queries";
import type {
  AnalysisCreateInput,
  AnalysisCreateOutput,
  AnalysisListItem,
} from "@/lib/contracts";
import {
  AnalysisCreateOutputSchema,
  AnalysisDetailSchema,
  AnalysisListItemSchema,
} from "@/lib/contracts";
import { getAiGatewayApiKey } from "@/lib/env";
import { RouteError } from "@/lib/http";
import { pasteAdapter } from "./adapters";
import {
  MAX_ANALYSIS_INPUT_CHARS,
  MAX_PERSISTED_RAW_LOG_CHARS,
} from "./constants";
import {
  dedupeDiagnostics,
  mapExtractedDiagnostics,
  rankDiagnostics,
} from "./diagnostics";
import { buildAnalysisPrompt } from "./prompt";
import { summarizeDiagnostics } from "./summary";

const serializeDate = (date: Date) => {
  return date.toISOString();
};

const inputAdapters = {
  paste: pasteAdapter,
} satisfies Record<AnalysisCreateInput["inputKind"], typeof pasteAdapter>;

const normalizeInput = (input: AnalysisCreateInput) => {
  return inputAdapters[input.inputKind].collect(input);
};

const toAnalysisDetail = (record: {
  id: string;
  createdAt: Date;
  inputKind: string;
  rawLogWasTruncated: boolean;
  summary: string;
  diagnostics: unknown;
}) => {
  const diagnosticCount = Array.isArray(record.diagnostics)
    ? record.diagnostics.length
    : 0;

  return AnalysisDetailSchema.parse({
    id: record.id,
    createdAt: serializeDate(record.createdAt),
    inputKind: record.inputKind,
    rawLogWasTruncated: record.rawLogWasTruncated,
    summary: record.summary,
    diagnosticCount,
    diagnostics: record.diagnostics,
  });
};

export const createAnalysis = async (
  input: AnalysisCreateInput
): Promise<AnalysisCreateOutput> => {
  const normalized = normalizeInput(input);

  if (!normalized.rawLog.trim()) {
    throw new RouteError(
      400,
      "EMPTY_INPUT",
      "Paste a CI log before analyzing."
    );
  }

  if (normalized.rawLog.length > MAX_ANALYSIS_INPUT_CHARS) {
    throw new RouteError(
      413,
      "INPUT_TOO_LARGE",
      `Pasted log exceeds the ${MAX_ANALYSIS_INPUT_CHARS.toLocaleString()} character limit.`
    );
  }

  const scrubbedRawLog = scrubSecrets(normalized.rawLog);

  let extraction: Awaited<ReturnType<typeof extractErrors>>;
  try {
    extraction = await extractErrors(scrubbedRawLog, {
      apiKey: getAiGatewayApiKey(),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message.includes("timed out")
        ? "Log analysis timed out."
        : "Log analysis failed.";
    throw new RouteError(502, "ANALYSIS_FAILED", message);
  }

  const diagnostics = rankDiagnostics(
    dedupeDiagnostics(
      mapExtractedDiagnostics(extraction.errors, extraction.detectedSource)
    )
  );

  if (diagnostics.length === 0) {
    throw new RouteError(
      422,
      "NO_DIAGNOSTICS",
      "No actionable diagnostics were found in the pasted log."
    );
  }

  const summary = await summarizeDiagnostics(diagnostics);
  const persistedRawLog = scrubbedRawLog.slice(0, MAX_PERSISTED_RAW_LOG_CHARS);
  const rawLogWasTruncated =
    scrubbedRawLog.length > MAX_PERSISTED_RAW_LOG_CHARS;

  const analysis = await createAnalysisRecord(
    {
      inputKind: normalized.inputKind,
      rawLog: persistedRawLog,
      rawLogWasTruncated,
      summary,
    },
    diagnostics
  );

  return AnalysisCreateOutputSchema.parse({
    id: analysis.id,
    createdAt: serializeDate(analysis.createdAt),
    inputKind: analysis.inputKind,
    rawLogWasTruncated: analysis.rawLogWasTruncated,
    summary: analysis.summary,
    diagnosticCount: diagnostics.length,
    diagnostics,
    prompt: buildAnalysisPrompt({
      summary,
      diagnostics,
    }),
  });
};

export const getAnalysisDetail = async (id: string) => {
  const record = await getAnalysisRecordById(id);
  if (!record) {
    throw new RouteError(404, "NOT_FOUND", "Analysis not found.");
  }

  const detail = toAnalysisDetail(record);
  return AnalysisCreateOutputSchema.parse({
    ...detail,
    prompt: buildAnalysisPrompt({
      summary: detail.summary,
      diagnostics: detail.diagnostics,
    }),
  });
};

export const listAnalyses = async (): Promise<AnalysisListItem[]> => {
  const records = await listRecentAnalyses();
  return records.map((record) =>
    AnalysisListItemSchema.parse({
      ...record,
      createdAt: serializeDate(record.createdAt),
    })
  );
};
