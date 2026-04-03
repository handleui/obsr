import {
  generateIssueSnapshot,
  type IssueDiagnosticDraft,
  type IssueSnapshotDraft,
  type RelatedIssueMemory,
} from "@obsr/issues";
import { getResponsesApiConfig } from "@/lib/env";
import type { IssueObservation, RelatedIssue } from "./schema";

export interface IssueSynthesisDraft extends IssueSnapshotDraft {}

export interface IssueSynthesisInput {
  diagnostics: IssueDiagnosticDraft[];
  observations: IssueObservation[];
  relatedIssues: RelatedIssue[];
  promptCacheKey?: string;
  safetyIdentifier?: string;
}

export interface IssueSynthesisProvider {
  synthesize: (
    input: IssueSynthesisInput
  ) => Promise<IssueSynthesisDraft | null>;
}

export const responsesIssueSynthesisProvider: IssueSynthesisProvider = {
  synthesize: ({
    diagnostics,
    observations,
    relatedIssues,
    promptCacheKey,
    safetyIdentifier,
  }) => {
    return generateIssueSnapshot(
      {
        diagnostics,
        observations: observations.map((observation) => ({
          sourceKind: observation.sourceKind,
          context: observation.context,
        })),
        relatedIssues: relatedIssues.map(
          (issue): RelatedIssueMemory => ({
            title: issue.title,
            summary: issue.summary,
            matchReason: issue.matchReason,
            status: issue.status,
            severity: issue.severity,
          })
        ),
      },
      {
        ...getResponsesApiConfig(),
        promptCacheKey,
        safetyIdentifier,
      }
    );
  },
};
