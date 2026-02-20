export type WebhookEventType =
  | "heal.pending"
  | "heal.running"
  | "heal.completed"
  | "heal.applied"
  | "heal.rejected"
  | "heal.failed";

export interface WebhookHealData {
  heal_id: string;
  type: "autofix" | "heal";
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
