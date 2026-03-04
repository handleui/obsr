export type WebhookEventType =
  | "resolve.pending"
  | "resolve.running"
  | "resolve.completed"
  | "resolve.applied"
  | "resolve.rejected"
  | "resolve.failed";

export interface WebhookHealData {
  resolve_id: string;
  type: "autofix" | "resolve";
  status: string;
  project_id: string;
  pr_number: number | null;
  commit_sha: string | null;
  patch?: string | null;
  files_changed?: string[] | null;
  applied_commit_sha?: string | null;
  failed_reason?: string | null;
  cost_usd?: number | null;
}

export interface WebhookPayload {
  id: string;
  event: WebhookEventType;
  timestamp: string;
  organization_id: string;
  data: WebhookHealData;
}
