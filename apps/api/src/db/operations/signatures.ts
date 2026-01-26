// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../client";
import { errorOccurrences, errorSignatures } from "../schema";

// Type for database operations that works with both Database and Transaction
type DbOrTx = Pick<Database, "insert" | "select" | "update">;

// ============================================================================
// Input Validation Constants
// ============================================================================
// Fingerprints are 16 hex chars (64 bits from SHA-256 truncation)
const FINGERPRINT_LENGTH = 16;
const FINGERPRINT_REGEX = /^[a-f0-9]{16}$/;

// UUID validation regex (module-level for performance)
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maximum lengths for text fields
const MAX_SOURCE_LENGTH = 64;
const MAX_RULE_ID_LENGTH = 255;
const MAX_CATEGORY_LENGTH = 32;
const MAX_PATTERN_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 500;
const MAX_FILE_PATH_LENGTH = 1000;
const MAX_COMMIT_LENGTH = 40;

// ============================================================================
// Validation Helpers
// ============================================================================

/** Validate fingerprint format (16 lowercase hex characters) */
const isValidFingerprint = (fingerprint: string): boolean =>
  FINGERPRINT_REGEX.test(fingerprint);

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

/** Validate and normalize UUID format */
const isValidUUID = (id: string): boolean => UUID_REGEX.test(id);

export interface SignatureUpsertData {
  fingerprint: string;
  source?: string;
  ruleId?: string;
  category?: string;
  normalizedPattern?: string;
  exampleMessage?: string;
}

export interface OccurrenceUpsertData {
  signatureId: string;
  projectId: string;
  commit?: string;
  filePath?: string;
}

/**
 * Upsert an error signature. Returns the signature ID.
 * If signature exists, returns existing ID without updating.
 *
 * Security: Validates fingerprint format and truncates text fields.
 * Note: For bulk operations, use bulkUpsertSignatures instead.
 */
export const upsertSignature = async (
  db: DbOrTx,
  data: SignatureUpsertData
): Promise<string> => {
  // SECURITY: Validate fingerprint format (16 hex chars)
  if (!isValidFingerprint(data.fingerprint)) {
    throw new Error(
      `Invalid fingerprint format: expected ${FINGERPRINT_LENGTH} hex characters`
    );
  }

  const id = crypto.randomUUID();

  // SECURITY: Truncate text fields to prevent oversized data
  const sanitizedData = {
    id,
    fingerprint: data.fingerprint,
    source: truncate(data.source, MAX_SOURCE_LENGTH),
    ruleId: truncate(data.ruleId, MAX_RULE_ID_LENGTH),
    category: truncate(data.category, MAX_CATEGORY_LENGTH),
    normalizedPattern: truncate(data.normalizedPattern, MAX_PATTERN_LENGTH),
    exampleMessage: truncate(data.exampleMessage, MAX_MESSAGE_LENGTH),
  };

  // Try insert with RETURNING - returns the inserted row or empty if conflict
  const inserted = await db
    .insert(errorSignatures)
    .values(sanitizedData)
    .onConflictDoNothing({ target: errorSignatures.fingerprint })
    .returning({ id: errorSignatures.id });

  // If insert succeeded, return the new ID
  const insertedRow = inserted[0];
  if (insertedRow) {
    return insertedRow.id;
  }

  // Conflict occurred - fetch existing ID (only on conflict, not every time)
  const result = await db
    .select({ id: errorSignatures.id })
    .from(errorSignatures)
    .where(eq(errorSignatures.fingerprint, data.fingerprint))
    .limit(1);

  return result[0]?.id ?? id;
};

/**
 * Upsert an error occurrence using INSERT ... ON CONFLICT DO UPDATE.
 * Single query instead of check-then-insert pattern.
 *
 * Security: Validates UUIDs and truncates file paths/commits.
 */
export const upsertOccurrence = async (
  db: DbOrTx,
  data: OccurrenceUpsertData
): Promise<void> => {
  // SECURITY: Validate UUID formats
  if (!isValidUUID(data.signatureId)) {
    throw new Error("Invalid signatureId format: expected UUID");
  }
  if (!isValidUUID(data.projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }

  const now = new Date();
  const id = crypto.randomUUID();

  // SECURITY: Truncate text fields
  const sanitizedCommit = truncate(data.commit, MAX_COMMIT_LENGTH);
  const sanitizedFilePath = truncate(data.filePath, MAX_FILE_PATH_LENGTH);

  // Single upsert query using ON CONFLICT DO UPDATE
  // Uses the unique index on (signatureId, projectId)
  await db
    .insert(errorOccurrences)
    .values({
      id,
      signatureId: data.signatureId,
      projectId: data.projectId,
      occurrenceCount: 1,
      runCount: 1,
      firstSeenCommit: sanitizedCommit,
      firstSeenAt: now,
      lastSeenCommit: sanitizedCommit,
      lastSeenAt: now,
      commonFiles: sanitizedFilePath ? [sanitizedFilePath] : null,
    })
    .onConflictDoUpdate({
      target: [errorOccurrences.signatureId, errorOccurrences.projectId],
      set: {
        occurrenceCount: sql`${errorOccurrences.occurrenceCount} + 1`,
        lastSeenCommit: sanitizedCommit,
        lastSeenAt: now,
        // Append file to commonFiles if not already present (max 20 files)
        // PostgreSQL jsonb ? operator checks if the array contains the given string value
        // e.g., '["a","b"]'::jsonb ? 'a' returns true
        commonFiles: sanitizedFilePath
          ? sql`CASE
              WHEN ${errorOccurrences.commonFiles} IS NULL THEN ${JSON.stringify([sanitizedFilePath])}::jsonb
              WHEN jsonb_array_length(${errorOccurrences.commonFiles}) >= 20 THEN ${errorOccurrences.commonFiles}
              WHEN NOT ${errorOccurrences.commonFiles} ? ${sanitizedFilePath} THEN ${errorOccurrences.commonFiles} || ${JSON.stringify([sanitizedFilePath])}::jsonb
              ELSE ${errorOccurrences.commonFiles}
            END`
          : sql`${errorOccurrences.commonFiles}`,
      },
    });
};

/**
 * Bulk upsert occurrences for a batch of errors.
 * Uses a single INSERT ... ON CONFLICT DO UPDATE query for all occurrences.
 *
 * Security: Validates UUIDs and truncates text fields.
 * Performance: O(1) queries instead of O(N) for N unique signatures.
 */
export const bulkUpsertOccurrences = async (
  db: DbOrTx,
  projectId: string,
  commit: string | undefined,
  occurrences: Array<{
    signatureId: string;
    filePath?: string;
  }>
): Promise<void> => {
  if (occurrences.length === 0) {
    return;
  }

  // SECURITY: Validate projectId
  if (!isValidUUID(projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }

  const now = new Date();
  const sanitizedCommit = truncate(commit, MAX_COMMIT_LENGTH);

  // SECURITY: Validate and sanitize all occurrences
  const values = occurrences
    .filter((occ) => isValidUUID(occ.signatureId)) // Skip invalid signatureIds
    .map((occ) => {
      // Truncate file path if present
      const sanitizedFilePath = occ.filePath
        ? truncate(occ.filePath, MAX_FILE_PATH_LENGTH)
        : undefined;

      return {
        id: crypto.randomUUID(),
        signatureId: occ.signatureId,
        projectId,
        occurrenceCount: 1,
        runCount: 1,
        firstSeenCommit: sanitizedCommit,
        firstSeenAt: now,
        lastSeenCommit: sanitizedCommit,
        lastSeenAt: now,
        commonFiles: sanitizedFilePath ? [sanitizedFilePath] : null,
      };
    });

  if (values.length === 0) {
    return;
  }

  // Bulk upsert in a single query
  // Note: PostgreSQL handles array of values efficiently
  await db
    .insert(errorOccurrences)
    .values(values)
    .onConflictDoUpdate({
      target: [errorOccurrences.signatureId, errorOccurrences.projectId],
      set: {
        occurrenceCount: sql`${errorOccurrences.occurrenceCount} + 1`,
        lastSeenCommit: sanitizedCommit,
        lastSeenAt: now,
        // Note: For bulk upsert, we can't efficiently merge filePaths from all
        // conflicting rows. Keep the existing commonFiles array.
        // Individual file tracking is still maintained via runErrors table.
      },
    });
};

/**
 * Bulk upsert signatures and occurrences for a batch of errors.
 *
 * Security: Validates fingerprints and UUIDs, truncates text fields.
 * Performance optimizations:
 * - Single bulk INSERT for signatures (O(1) query)
 * - Single SELECT to fetch all signature IDs (O(1) query)
 * - Single bulk INSERT...ON CONFLICT for occurrences (O(1) query)
 * - Total: 3 queries regardless of batch size (vs 2N+1 before)
 */
export const bulkUpsertSignaturesAndOccurrences = async (
  db: DbOrTx,
  projectId: string,
  commit: string | undefined,
  errors: Array<{
    fingerprint: string;
    source?: string;
    ruleId?: string;
    category?: string;
    normalizedPattern?: string;
    exampleMessage?: string;
    filePath?: string;
  }>
): Promise<Map<string, string>> => {
  // Map fingerprint -> signatureId
  const fingerprintToId = new Map<string, string>();

  if (errors.length === 0) {
    return fingerprintToId;
  }

  // SECURITY: Validate projectId
  if (!isValidUUID(projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }

  // SECURITY: Filter out errors with invalid fingerprints
  const validErrors = errors.filter((e) => isValidFingerprint(e.fingerprint));
  const filteredCount = errors.length - validErrors.length;

  // Capture filtered fingerprints for observability
  if (filteredCount > 0) {
    Sentry.captureMessage(
      `Filtered ${filteredCount} invalid fingerprints during signature upsert`,
      {
        level: "warning",
        extra: { totalErrors: errors.length, validErrors: validErrors.length },
      }
    );
  }

  if (validErrors.length === 0) {
    return fingerprintToId;
  }

  // Dedupe by fingerprint, collecting all file paths per fingerprint
  const uniqueErrors = new Map<
    string,
    (typeof validErrors)[0] & { allFilePaths: string[] }
  >();
  for (const error of validErrors) {
    const existing = uniqueErrors.get(error.fingerprint);
    if (existing) {
      // Add file path to existing entry if not already present
      const sanitizedPath = truncate(error.filePath, MAX_FILE_PATH_LENGTH);
      if (sanitizedPath && !existing.allFilePaths.includes(sanitizedPath)) {
        existing.allFilePaths.push(sanitizedPath);
      }
    } else {
      const sanitizedPath = truncate(error.filePath, MAX_FILE_PATH_LENGTH);
      uniqueErrors.set(error.fingerprint, {
        ...error,
        allFilePaths: sanitizedPath ? [sanitizedPath] : [],
      });
    }
  }

  // SECURITY: Bulk insert signatures with sanitized data (on conflict do nothing)
  const signatureValues = Array.from(uniqueErrors.values()).map((e) => ({
    id: crypto.randomUUID(),
    fingerprint: e.fingerprint,
    source: truncate(e.source, MAX_SOURCE_LENGTH),
    ruleId: truncate(e.ruleId, MAX_RULE_ID_LENGTH),
    category: truncate(e.category, MAX_CATEGORY_LENGTH),
    normalizedPattern: truncate(e.normalizedPattern, MAX_PATTERN_LENGTH),
    exampleMessage: truncate(e.exampleMessage, MAX_MESSAGE_LENGTH),
  }));

  if (signatureValues.length > 0) {
    await db
      .insert(errorSignatures)
      .values(signatureValues)
      .onConflictDoNothing({ target: errorSignatures.fingerprint });
  }

  // Fetch all signature IDs in a single query
  const fingerprints = Array.from(uniqueErrors.keys());
  const existingSignatures = await db
    .select({
      id: errorSignatures.id,
      fingerprint: errorSignatures.fingerprint,
    })
    .from(errorSignatures)
    .where(inArray(errorSignatures.fingerprint, fingerprints));

  for (const sig of existingSignatures) {
    fingerprintToId.set(sig.fingerprint, sig.id);
  }

  // Prepare occurrence data for bulk upsert
  const occurrenceData: Array<{ signatureId: string; filePath?: string }> = [];
  for (const [fingerprint, error] of uniqueErrors) {
    const signatureId = fingerprintToId.get(fingerprint);
    if (signatureId) {
      // Use the first file path for the occurrence record
      // All file paths are preserved in the individual runErrors records
      occurrenceData.push({
        signatureId,
        filePath: error.allFilePaths[0],
      });
    }
  }

  // Bulk upsert all occurrences in a single query
  await bulkUpsertOccurrences(db, projectId, commit, occurrenceData);

  return fingerprintToId;
};

/**
 * Increment run count for all occurrences in a project.
 * Call this once per run after processing all errors.
 *
 * Security: Validates UUIDs before executing query.
 */
export const incrementRunCount = async (
  db: DbOrTx,
  projectId: string,
  signatureIds: string[]
): Promise<void> => {
  if (signatureIds.length === 0) {
    return;
  }

  // SECURITY: Validate projectId
  if (!isValidUUID(projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }

  // SECURITY: Filter to only valid signature IDs
  const validSignatureIds = signatureIds.filter(isValidUUID);
  if (validSignatureIds.length === 0) {
    return;
  }

  await db
    .update(errorOccurrences)
    .set({
      runCount: sql`${errorOccurrences.runCount} + 1`,
    })
    .where(
      and(
        eq(errorOccurrences.projectId, projectId),
        inArray(errorOccurrences.signatureId, validSignatureIds)
      )
    );
};

/**
 * Mark occurrences as potentially fixed.
 * Called when a run succeeds without certain errors.
 *
 * Security: Validates UUIDs and truncates commit hash.
 */
export const markPotentiallyFixed = async (
  db: DbOrTx,
  projectId: string,
  commit: string,
  signatureIds: string[]
): Promise<void> => {
  if (signatureIds.length === 0) {
    return;
  }

  // SECURITY: Validate projectId
  if (!isValidUUID(projectId)) {
    throw new Error("Invalid projectId format: expected UUID");
  }

  // SECURITY: Filter to only valid signature IDs
  const validSignatureIds = signatureIds.filter(isValidUUID);
  if (validSignatureIds.length === 0) {
    return;
  }

  const now = new Date();
  const sanitizedCommit = truncate(commit, MAX_COMMIT_LENGTH);

  await db
    .update(errorOccurrences)
    .set({
      fixedAt: now,
      fixedByCommit: sanitizedCommit,
    })
    .where(
      and(
        eq(errorOccurrences.projectId, projectId),
        inArray(errorOccurrences.signatureId, validSignatureIds),
        isNull(errorOccurrences.fixedAt) // Only mark if not already marked
      )
    );
};
