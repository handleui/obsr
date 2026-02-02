export type HealType = "autofix" | "heal";

export const HealTypes = {
  Autofix: "autofix",
  Heal: "heal",
} as const satisfies Record<string, HealType>;

export type HealStatus =
  | "found"
  | "pending"
  | "running"
  | "completed"
  | "applied"
  | "rejected"
  | "failed";

export const HealStatuses = {
  Found: "found",
  Pending: "pending",
  Running: "running",
  Completed: "completed",
  Applied: "applied",
  Rejected: "rejected",
  Failed: "failed",
} as const satisfies Record<string, HealStatus>;

export type HealCreateStatus = Extract<HealStatus, "found" | "pending">;

export type HealUpdateStatus = Extract<
  HealStatus,
  "running" | "completed" | "applied" | "rejected" | "failed"
>;

export interface HealSummary {
  model?: string;
  patchApplied?: boolean;
  verificationPassed?: boolean;
  toolCalls?: number;
}
