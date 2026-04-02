import type {
  IssueCategory,
  IssueIngestInput,
  IssueObservationContext,
  ObservationSourceKind,
} from "../schema";

export interface IssueDiagnosticSeed {
  message: string;
  severity?: "error" | "warning" | null;
  category?: IssueCategory | string | null;
  source?: string | null;
  ruleId?: string | null;
  filePath?: string | null;
  line?: number | null;
  column?: number | null;
  evidence?: string | null;
}

export interface IssueDiagnosticDraft {
  fingerprint: string;
  repoFingerprint: string;
  loreFingerprint: string;
  message: string;
  severity: "error" | "warning" | null;
  category: IssueCategory | null;
  source: string | null;
  ruleId: string | null;
  filePath: string | null;
  line: number | null;
  column: number | null;
  evidence: string;
}

export interface IssueObservationDraft {
  sourceKind: ObservationSourceKind;
  rawText?: string;
  rawPayload?: unknown;
  context: IssueObservationContext;
  capturedAt: Date;
  wasRedacted: boolean;
  wasTruncated: boolean;
  diagnostics: IssueDiagnosticDraft[];
}

export interface IssueAdapter {
  readonly sourceKinds: ObservationSourceKind[];
  normalize: (input: IssueIngestInput) => Promise<IssueObservationDraft>;
}
