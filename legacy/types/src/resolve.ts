export type ResolveType = "autofix" | "resolve";

export const ResolveTypes = {
  Autofix: "autofix" as const,
  Resolve: "resolve" as const,
};

export type ResolveStatus =
  | "found"
  | "pending"
  | "running"
  | "completed"
  | "applied"
  | "rejected"
  | "failed";

export const ResolveStatuses = {
  Found: "found" as const,
  Pending: "pending" as const,
  Running: "running" as const,
  Completed: "completed" as const,
  Applied: "applied" as const,
  Rejected: "rejected" as const,
  Failed: "failed" as const,
};

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
