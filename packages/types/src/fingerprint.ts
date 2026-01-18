/**
 * Hierarchical error fingerprints for identification and tracking.
 */
export interface ErrorFingerprints {
  /**
   * Cross-repo fingerprint for lore matching.
   * Based on: source:ruleId:normalizedPattern
   * Same error type across repos will have the same lore fingerprint.
   */
  readonly lore: string;

  /**
   * Per-repo fingerprint for tracking within a project.
   * Based on: loreFingerprint + normalizedFilePath
   * Same error in same relative file path across commits.
   */
  readonly repo: string;

  /**
   * Instance fingerprint for exact deduplication.
   * Based on: repoFingerprint + line + column
   * Exact same error at exact same location.
   */
  readonly instance: string;

  /**
   * The normalized message pattern used for fingerprinting.
   * Stored for debugging and human readability.
   */
  readonly normalizedPattern: string;
}

/**
 * Signature metadata stored in the database.
 */
export interface ErrorSignature {
  readonly id: string;
  readonly fingerprint: string;
  readonly source?: string;
  readonly ruleId?: string;
  readonly category?: string;
  readonly normalizedPattern?: string;
  readonly exampleMessage?: string;
  readonly loreCandidate: boolean;
  readonly loreSyncedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Per-repo occurrence tracking data.
 */
export interface ErrorOccurrence {
  readonly id: string;
  readonly signatureId: string;
  readonly projectId: string;
  readonly occurrenceCount: number;
  readonly runCount: number;
  readonly firstSeenCommit?: string;
  readonly firstSeenAt: Date;
  readonly lastSeenCommit?: string;
  readonly lastSeenAt: Date;
  readonly fixedAt?: Date;
  readonly fixedByCommit?: string;
  readonly fixVerified: boolean;
  readonly commonFiles?: string[];
}
