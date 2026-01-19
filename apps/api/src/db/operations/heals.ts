import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../client";
import { type Heal, heals } from "../schema";

// Type for database operations that works with both Database and Transaction
type DbOrTx = Pick<Database, "insert" | "select" | "update">;

// ============================================================================
// Input Validation Constants
// ============================================================================

// UUID validation regex (module-level for performance)
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maximum lengths for text fields
const MAX_COMMIT_LENGTH = 64;
const MAX_SOURCE_LENGTH = 64;
const MAX_COMMAND_LENGTH = 500;
const MAX_COMMIT_MESSAGE_LENGTH = 500;
const MAX_REJECTION_REASON_LENGTH = 2000;
const MAX_FAILED_REASON_LENGTH = 2000;
const MAX_PATCH_LENGTH = 1_000_000; // 1MB for patches
const MAX_REJECTED_BY_LENGTH = 255;

// ============================================================================
// Validation Helpers
// ============================================================================

/** Validate and normalize UUID format */
const isValidUUID = (id: string): boolean => UUID_REGEX.test(id);

/** Validate array of UUIDs, filtering out invalid ones */
const validateUUIDs = (ids: string[] | undefined): string[] | undefined => {
  if (!ids || ids.length === 0) {
    return undefined;
  }
  const valid = ids.filter(isValidUUID);
  return valid.length > 0 ? valid : undefined;
};

/** Truncate string to max length, returning undefined for empty/null */
const truncate = (
  value: string | undefined,
  maxLength: number
): string | undefined => {
  if (!value) {
    return undefined;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

/**
 * Create a new heal record.
 * Returns the heal ID.
 *
 * Security: Validates UUIDs and truncates text fields.
 */
export const createHeal = async (
  db: DbOrTx,
  data: {
    type: "autofix" | "heal";
    projectId: string;
    runId?: string;
    commitSha?: string;
    prNumber?: number;
    errorIds?: string[];
    signatureIds?: string[];
    autofixSource?: string;
    autofixCommand?: string;
    commitMessage?: string;
  }
): Promise<string> => {
  // SECURITY: Validate required UUIDs
  if (!isValidUUID(data.projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }
  if (data.runId && !isValidUUID(data.runId)) {
    throw new Error("Invalid runId format: expected UUID");
  }

  const id = crypto.randomUUID();
  const now = new Date();

  // SECURITY: Truncate text fields and validate UUID arrays
  const sanitizedData = {
    id,
    type: data.type,
    status: "pending" as const,
    projectId: data.projectId,
    runId: data.runId,
    commitSha: truncate(data.commitSha, MAX_COMMIT_LENGTH),
    prNumber: data.prNumber,
    errorIds: validateUUIDs(data.errorIds),
    signatureIds: validateUUIDs(data.signatureIds),
    autofixSource: truncate(data.autofixSource, MAX_SOURCE_LENGTH),
    autofixCommand: truncate(data.autofixCommand, MAX_COMMAND_LENGTH),
    commitMessage: truncate(data.commitMessage, MAX_COMMIT_MESSAGE_LENGTH),
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(heals).values(sanitizedData);

  return id;
};

/**
 * Update heal status and associated data.
 *
 * Security: Validates UUID and truncates text fields.
 */
export const updateHealStatus = async (
  db: DbOrTx,
  healId: string,
  status: "running" | "completed" | "applied" | "rejected" | "failed",
  data?: {
    patch?: string;
    commitMessage?: string;
    filesChanged?: string[];
    filesChangedWithContent?: Array<{ path: string; content: string | null }>;
    healResult?: object;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    failedReason?: string;
  }
): Promise<void> => {
  // SECURITY: Validate UUID
  if (!isValidUUID(healId)) {
    throw new Error("Invalid healId format: expected UUID");
  }

  const now = new Date();

  // SECURITY: Truncate text fields including large patch data
  const sanitizedData = {
    status,
    patch: truncate(data?.patch, MAX_PATCH_LENGTH),
    commitMessage: truncate(data?.commitMessage, MAX_COMMIT_MESSAGE_LENGTH),
    filesChanged: data?.filesChanged,
    filesChangedWithContent: data?.filesChangedWithContent,
    healResult: data?.healResult,
    costUsd: data?.costUsd,
    inputTokens: data?.inputTokens,
    outputTokens: data?.outputTokens,
    failedReason: truncate(data?.failedReason, MAX_FAILED_REASON_LENGTH),
    updatedAt: now,
  };

  await db.update(heals).set(sanitizedData).where(eq(heals.id, healId));
};

/**
 * Apply a heal (mark as applied with commit SHA).
 *
 * Security: Validates UUIDs and truncates commit hash.
 */
export const applyHeal = async (
  db: DbOrTx,
  healId: string,
  appliedCommitSha: string
): Promise<void> => {
  // SECURITY: Validate UUID
  if (!isValidUUID(healId)) {
    throw new Error("Invalid healId format: expected UUID");
  }

  const now = new Date();

  await db
    .update(heals)
    .set({
      status: "applied",
      appliedAt: now,
      appliedCommitSha: truncate(appliedCommitSha, MAX_COMMIT_LENGTH),
      updatedAt: now,
    })
    .where(eq(heals.id, healId));
};

/**
 * Reject a heal.
 *
 * Security: Validates UUIDs and truncates text fields.
 */
export const rejectHeal = async (
  db: DbOrTx,
  healId: string,
  rejectedBy: string,
  reason?: string
): Promise<void> => {
  // SECURITY: Validate UUID
  if (!isValidUUID(healId)) {
    throw new Error("Invalid healId format: expected UUID");
  }

  const now = new Date();

  // SECURITY: Truncate rejectedBy and reason fields
  await db
    .update(heals)
    .set({
      status: "rejected",
      rejectedAt: now,
      rejectedBy: truncate(rejectedBy, MAX_REJECTED_BY_LENGTH),
      rejectionReason: truncate(reason, MAX_REJECTION_REASON_LENGTH),
      updatedAt: now,
    })
    .where(eq(heals.id, healId));
};

/**
 * Get heals by project and PR number.
 *
 * Security: Validates UUID.
 */
export const getHealsByPr = async (
  db: DbOrTx,
  projectId: string,
  prNumber: number
): Promise<Heal[]> => {
  // SECURITY: Validate UUID
  if (!isValidUUID(projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }

  return await db
    .select()
    .from(heals)
    .where(and(eq(heals.projectId, projectId), eq(heals.prNumber, prNumber)))
    .orderBy(desc(heals.createdAt));
};

/**
 * Get heal by ID.
 *
 * Security: Validates UUID.
 */
export const getHealById = async (
  db: DbOrTx,
  healId: string
): Promise<Heal | null> => {
  // SECURITY: Validate UUID
  if (!isValidUUID(healId)) {
    throw new Error("Invalid healId format: expected UUID");
  }

  const result = await db
    .select()
    .from(heals)
    .where(eq(heals.id, healId))
    .limit(1);

  return result[0] ?? null;
};

/**
 * Get pending heals for a project.
 *
 * Security: Validates UUID.
 */
export const getPendingHeals = async (
  db: DbOrTx,
  projectId: string
): Promise<Heal[]> => {
  // SECURITY: Validate UUID
  if (!isValidUUID(projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }

  return await db
    .select()
    .from(heals)
    .where(and(eq(heals.projectId, projectId), eq(heals.status, "pending")))
    .orderBy(desc(heals.createdAt));
};

/**
 * Check if a heal already exists for a specific PR and autofix source.
 * Used for deduplication to prevent creating duplicate heals.
 *
 * Security: Validates UUID.
 */
export const healExistsForPrAndSource = async (
  db: DbOrTx,
  projectId: string,
  prNumber: number,
  autofixSource: string
): Promise<boolean> => {
  // SECURITY: Validate UUID
  if (!isValidUUID(projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }

  const result = await db
    .select({ id: heals.id })
    .from(heals)
    .where(
      and(
        eq(heals.projectId, projectId),
        eq(heals.prNumber, prNumber),
        eq(heals.autofixSource, autofixSource),
        // Only consider active heals (not rejected/failed)
        eq(heals.status, "pending")
      )
    )
    .limit(1);

  return result.length > 0;
};

/**
 * Find pending or running heal for a specific PR and autofix source.
 * Used by autofix-result endpoint to update the correct heal record.
 *
 * Security: Validates UUID.
 */
export const getHealByPrAndSource = async (
  db: DbOrTx,
  projectId: string,
  prNumber: number,
  autofixSource: string
): Promise<Heal | null> => {
  // SECURITY: Validate UUID
  if (!isValidUUID(projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }

  const result = await db
    .select()
    .from(heals)
    .where(
      and(
        eq(heals.projectId, projectId),
        eq(heals.prNumber, prNumber),
        eq(heals.autofixSource, autofixSource),
        // Only consider active heals (pending or running)
        inArray(heals.status, ["pending", "running"])
      )
    )
    .orderBy(desc(heals.createdAt))
    .limit(1);

  return result[0] ?? null;
};

/**
 * Mark stale heals as failed after a timeout period.
 * Returns the count of heals that were marked as failed.
 *
 * @param db - Database client
 * @param timeoutMinutes - Heals older than this many minutes will be marked as failed
 * @param healType - Type of heal to clean up ("autofix" or "heal")
 */
export const markStaleHealsAsFailed = async (
  db: DbOrTx,
  timeoutMinutes: number,
  healType: "autofix" | "heal"
): Promise<number> => {
  // SECURITY: Validate timeoutMinutes to prevent SQL injection via sql.raw()
  // The validation below is CRITICAL - sql.raw() bypasses parameterization,
  // so we must ensure timeoutMinutes is strictly an integer between 1-1440.
  // Do NOT weaken this validation without updating the SQL construction.
  if (
    !Number.isInteger(timeoutMinutes) ||
    timeoutMinutes < 1 ||
    timeoutMinutes > 1440
  ) {
    throw new Error(
      "Invalid timeout: must be an integer between 1 and 1440 minutes"
    );
  }

  // SECURITY NOTE: sql.raw() is used here because Drizzle doesn't support
  // parameterized INTERVAL syntax. This is safe because:
  // 1. timeoutMinutes is validated above as an integer in range [1, 1440]
  // 2. String(timeoutMinutes) can only produce decimal digit characters
  // 3. No user input reaches this function without validation
  const result = await db
    .update(heals)
    .set({
      status: "failed",
      failedReason: "Autofix timed out",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(heals.type, healType),
        inArray(heals.status, ["pending", "running"]),
        lt(
          heals.updatedAt,
          sql`NOW() - INTERVAL '${sql.raw(String(timeoutMinutes))} minutes'`
        )
      )
    )
    .returning({ id: heals.id });

  return result.length;
};
