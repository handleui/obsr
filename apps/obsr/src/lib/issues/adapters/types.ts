import type { IssueObservationDraft as SharedIssueObservationDraft } from "@obsr/issues";
import type { IssueIngestInput } from "../schema";

export interface IssueAdapterAiContext {
  promptCacheKey?: string;
  safetyIdentifier?: string;
}

export interface IssueAdapter {
  readonly sourceKinds: IssueIngestInput["sourceKind"][];
  normalize: (
    input: IssueIngestInput,
    aiContext?: IssueAdapterAiContext
  ) => Promise<SharedIssueObservationDraft>;
}

export type {
  IssueDiagnosticDraft,
  IssueDiagnosticSeed,
  IssueObservationDraft,
} from "@obsr/issues";
