import {
  createStructuredResponse,
  DEFAULT_SMART_MODEL,
  handleResponsesError,
  type ResponsesRuntimeOptions,
  zodTextFormat,
} from "@obsr/ai";
import { scrubFilePath, scrubSecrets } from "@obsr/types";
import { z } from "zod";
import {
  rankIssueDiagnostics,
  sanitizeIssueObservationMemory,
  sanitizeRelatedIssueMemory,
} from "./normalize.js";
import {
  type IssueDiagnosticDraft,
  type IssueObservationMemory,
  IssueObservationMemorySchema,
  type IssueSnapshotDraft,
  IssueSnapshotDraftSchema,
  type RelatedIssueMemory,
  RelatedIssueMemorySchema,
} from "./schema.js";

export interface IssueSynthesisInput {
  diagnostics: IssueDiagnosticDraft[];
  observations: IssueObservationMemory[];
  relatedIssues: RelatedIssueMemory[];
}

const RawIssueSnapshotDraftSchema = IssueSnapshotDraftSchema;
const ISSUE_SNAPSHOT_TEXT_FORMAT = zodTextFormat(
  RawIssueSnapshotDraftSchema,
  "issue_snapshot"
);
const MAX_SYNTHESIS_DIAGNOSTICS = 8;
const MAX_SYNTHESIS_OBSERVATIONS = 6;
const MAX_SYNTHESIS_RELATED_ISSUES = 5;
const DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS = 800;
const MAX_SNAPSHOT_MESSAGE_CHARS = 500;
const MAX_SNAPSHOT_FILE_PATH_CHARS = 240;
const MAX_SNAPSHOT_EVIDENCE_CHARS = 500;

const ISSUE_SNAPSHOT_SYSTEM_PROMPT = `You cluster engineering failures into one plain-English issue summary.

Return strict JSON only.

Rules:
- Be concise, concrete, and action-first.
- Prefer the smallest safe fix plan.
- Use related issue memory only when it clearly supports the diagnosis.
- Do not invent certainty or hidden causes.
- If the evidence is too weak, reflect that uncertainty in the summary and plan.
- Do not include markdown or prose outside JSON.`;

const sanitizeSnapshotText = (
  value: string | null | undefined,
  maxChars: number,
  scrubPath = false
) => {
  if (!value?.trim()) {
    return null;
  }

  const secretScrubbed = scrubSecrets(value.trim());
  const pathScrubbed = scrubPath
    ? (scrubFilePath(secretScrubbed) ?? secretScrubbed)
    : secretScrubbed;

  return pathScrubbed.slice(0, maxChars);
};

const buildSnapshotPrompt = ({
  diagnostics,
  observations,
  relatedIssues,
}: IssueSynthesisInput) => {
  const prioritizedDiagnostics = rankIssueDiagnostics(diagnostics).slice(
    0,
    MAX_SYNTHESIS_DIAGNOSTICS
  );
  const observationContext = z
    .array(IssueObservationMemorySchema)
    .parse(observations.map(sanitizeIssueObservationMemory))
    .slice(-MAX_SYNTHESIS_OBSERVATIONS)
    .map((observation) => ({
      sourceKind: observation.sourceKind,
      environment: observation.context.environment,
      repo: observation.context.repo,
      app: observation.context.app,
      service: observation.context.service,
      command: observation.context.command,
      branch: observation.context.branch,
    }));

  return JSON.stringify(
    {
      observations: observationContext,
      diagnostics: prioritizedDiagnostics.map((diagnostic) => ({
        message:
          sanitizeSnapshotText(
            diagnostic.message,
            MAX_SNAPSHOT_MESSAGE_CHARS
          ) ?? "Unknown issue",
        severity: diagnostic.severity,
        category: diagnostic.category,
        source: sanitizeSnapshotText(diagnostic.source, 80),
        ruleId: sanitizeSnapshotText(diagnostic.ruleId, 120),
        filePath: sanitizeSnapshotText(
          diagnostic.filePath,
          MAX_SNAPSHOT_FILE_PATH_CHARS,
          true
        ),
        line: diagnostic.line,
        evidence:
          sanitizeSnapshotText(
            diagnostic.evidence,
            MAX_SNAPSHOT_EVIDENCE_CHARS,
            true
          ) ?? "Evidence unavailable.",
      })),
      relatedIssues: z
        .array(RelatedIssueMemorySchema)
        .parse(relatedIssues.map(sanitizeRelatedIssueMemory))
        .slice(0, MAX_SYNTHESIS_RELATED_ISSUES),
    },
    null,
    2
  );
};

export const generateIssueSnapshot = async (
  input: IssueSynthesisInput,
  options: ResponsesRuntimeOptions
): Promise<IssueSnapshotDraft | null> => {
  if (input.diagnostics.length === 0) {
    return null;
  }

  try {
    const result = await createStructuredResponse({
      options: {
        ...options,
        model: options.model ?? DEFAULT_SMART_MODEL,
        maxOutputTokens:
          options.maxOutputTokens ?? DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS,
        reasoningEffort: options.reasoningEffort ?? "minimal",
      },
      request: {
        system: ISSUE_SNAPSHOT_SYSTEM_PROMPT,
        prompt: buildSnapshotPrompt(input),
        textFormat: ISSUE_SNAPSHOT_TEXT_FORMAT,
      },
    });

    return result.parsed;
  } catch (error) {
    return handleResponsesError(error, "Issue synthesis failed");
  }
};
