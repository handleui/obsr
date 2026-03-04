export type ResolveType = "autofix" | "resolve";

export const ResolveTypes = {
  Autofix: "autofix",
  Resolve: "resolve",
} as const satisfies Record<string, ResolveType>;

export type ResolveStatus =
  | "found"
  | "pending"
  | "running"
  | "completed"
  | "applied"
  | "rejected"
  | "failed";

export const ResolveStatuses = {
  Found: "found",
  Pending: "pending",
  Running: "running",
  Completed: "completed",
  Applied: "applied",
  Rejected: "rejected",
  Failed: "failed",
} as const satisfies Record<string, ResolveStatus>;

export type ResolveCreateStatus = Extract<ResolveStatus, "found" | "pending">;

export type ResolveUpdateStatus = Extract<
  ResolveStatus,
  "running" | "completed" | "applied" | "rejected" | "failed"
>;

export interface ResolveSummary {
  model?: string;
  patchApplied?: boolean;
  verificationPassed?: boolean;
  toolCalls?: number;
}
