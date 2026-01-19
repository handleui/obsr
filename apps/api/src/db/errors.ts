// ============================================================================
// Database Error Classifier
// ============================================================================
// Classifies PostgreSQL errors as transient (retry) vs permanent (investigate)
// to provide actionable error messages to users and operators.

/**
 * Error classification for DB operations
 */
export type DbErrorType = "TRANSIENT" | "PERMANENT" | "UNKNOWN";

/**
 * Database operation that failed
 */
export type DbOperation =
  | "insert"
  | "update"
  | "upsert"
  | "delete"
  | "select"
  | "transaction";

/**
 * Classified database error with diagnostic info
 */
export interface ClassifiedDbError {
  /** Error classification */
  type: DbErrorType;
  /** Machine-readable error code */
  code: string;
  /** Human-readable message (sanitized for API responses) */
  message: string;
  /** Suggested action */
  action: string;
  /** Original error code from Postgres (for logging) */
  pgCode?: string;
  /** Which operation failed */
  operation?: DbOperation;
  /** Which table was involved */
  table?: string;
  /** Additional diagnostic info (for logging only) */
  details?: string;
}

// ============================================================================
// PostgreSQL Error Code Classification
// ============================================================================
// Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html

/**
 * Transient errors - safe to retry
 */
const TRANSIENT_ERROR_CODES = new Set([
  // Class 08 - Connection Exception
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08007", // transaction_resolution_unknown
  "08P01", // protocol_violation

  // Class 40 - Transaction Rollback
  "40000", // transaction_rollback
  "40001", // serialization_failure
  "40002", // transaction_integrity_constraint_violation
  "40003", // statement_completion_unknown
  "40P01", // deadlock_detected

  // Class 53 - Insufficient Resources
  "53000", // insufficient_resources
  "53100", // disk_full
  "53200", // out_of_memory
  "53300", // too_many_connections

  // Class 54 - Program Limit Exceeded
  "54000", // program_limit_exceeded

  // Class 57 - Operator Intervention
  "57000", // operator_intervention
  "57014", // query_canceled
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "57P04", // database_dropped

  // Class 58 - System Error
  "58000", // system_error
  "58030", // io_error

  // Class 55 - Object Not In Prerequisite State (can be transient)
  "55000", // object_not_in_prerequisite_state
  "55006", // object_in_use
  "55P03", // lock_not_available

  // Connection pool errors (Neon/Hyperdrive specific)
  // XX000 in direct PostgreSQL usually indicates bugs, but in pooled environments
  // (Neon serverless + Cloudflare Hyperdrive) it often signals transient pool
  // state issues that resolve on retry. Safe to retry here; permanent failures
  // will fail again and be reclassified.
  "XX000", // internal_error
]);

/**
 * Permanent errors - do not retry, fix data/schema
 */
const PERMANENT_ERROR_CODES = new Set([
  // Class 22 - Data Exception
  "22000", // data_exception
  "22001", // string_data_right_truncation
  "22003", // numeric_value_out_of_range
  "22005", // error_in_assignment
  "22007", // invalid_datetime_format
  "22008", // datetime_field_overflow
  "22009", // invalid_time_zone_displacement_value
  "22012", // division_by_zero
  "22015", // interval_field_overflow
  "22018", // invalid_character_value_for_cast
  "22019", // invalid_escape_character
  "22021", // character_not_in_repertoire
  "22022", // indicator_overflow
  "22023", // invalid_parameter_value
  "22025", // invalid_escape_sequence
  "22P02", // invalid_text_representation
  "22P03", // invalid_binary_representation
  "22P06", // nonstandard_use_of_escape_character
  "2200G", // most_specific_type_mismatch

  // Class 23 - Integrity Constraint Violation
  "23000", // integrity_constraint_violation
  "23001", // restrict_violation
  "23502", // not_null_violation
  "23503", // foreign_key_violation
  "23505", // unique_violation
  "23514", // check_violation
  "23P01", // exclusion_violation

  // Class 42 - Syntax Error or Access Rule Violation
  "42000", // syntax_error_or_access_rule_violation
  "42501", // insufficient_privilege
  "42601", // syntax_error
  "42602", // invalid_name
  "42611", // invalid_column_definition
  "42622", // name_too_long
  "42701", // duplicate_column
  "42702", // ambiguous_column
  "42703", // undefined_column
  "42704", // undefined_object
  "42710", // duplicate_object
  "42712", // duplicate_alias
  "42723", // duplicate_function
  "42725", // ambiguous_function
  "42803", // grouping_error
  "42804", // datatype_mismatch
  "42809", // wrong_object_type
  "42830", // invalid_foreign_key
  "42846", // cannot_coerce
  "42883", // undefined_function
  "42939", // reserved_name
  "42P01", // undefined_table
  "42P02", // undefined_parameter
]);

// ============================================================================
// Error Message Mapping
// ============================================================================

const PERMANENT_ERROR_MESSAGES: Record<
  string,
  { message: string; action: string }
> = {
  "23505": {
    message: "Duplicate record already exists",
    action: "Check for duplicate data - the record may already exist",
  },
  "23503": {
    message: "Referenced record not found",
    action: "Check that referenced records exist before inserting",
  },
  "23502": {
    message: "Required field is missing",
    action: "Ensure all required fields are provided",
  },
  "23514": {
    message: "Data validation failed",
    action: "Check that data meets all constraints",
  },
  "42P01": {
    message: "Table not found",
    action: "Database schema may be out of sync - contact support",
  },
  "42703": {
    message: "Column not found",
    action: "Database schema may be out of sync - contact support",
  },
  "22001": {
    message: "Data too long for field",
    action: "Reduce the size of the input data",
  },
  "22P02": {
    message: "Invalid data format",
    action: "Check that data types match expected format",
  },
};

const TRANSIENT_ERROR_MESSAGES: Record<
  string,
  { message: string; action: string }
> = {
  "40001": {
    message: "Transaction conflict detected",
    action: "Retry the request - concurrent modification occurred",
  },
  "40P01": {
    message: "Deadlock detected",
    action: "Retry the request - database will resolve the deadlock",
  },
  "57P01": {
    message: "Database is restarting",
    action: "Retry in a few seconds - database maintenance in progress",
  },
  "53300": {
    message: "Too many connections",
    action: "Retry in a few seconds - connection pool exhausted",
  },
  "08006": {
    message: "Connection lost",
    action: "Retry the request - connection was interrupted",
  },
  "57014": {
    message: "Query was cancelled",
    action: "Retry the request - query took too long",
  },
  "55P03": {
    message: "Lock not available",
    action: "Retry the request - resource is temporarily locked",
  },
};

// ============================================================================
// Error Detection Patterns
// ============================================================================

/**
 * Detect transient errors from error messages when code is unavailable.
 * Exported for reuse in other error classification contexts (e.g., autofix orchestrator).
 */
export const TRANSIENT_MESSAGE_PATTERNS = [
  /connection.*(?:refused|reset|closed|timeout|timed out)/i,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /socket hang up/i,
  /connection pool.*exhausted/i,
  /too many connections/i,
  /deadlock/i,
  /serialization failure/i,
  /could not connect/i,
  /connection terminated/i,
  /server closed the connection/i,
  /Connection terminated unexpectedly/i,
];

/** Detect permanent errors from error messages when code is unavailable */
const PERMANENT_MESSAGE_PATTERNS = [
  /unique.*constraint.*violated/i,
  /duplicate key.*violates unique constraint/i,
  /foreign key.*constraint.*violated/i,
  /violates foreign key constraint/i,
  /not-null constraint/i,
  /violates not-null constraint/i,
  /violates check constraint/i,
  /relation.*does not exist/i,
  /column.*does not exist/i,
  /invalid input syntax/i,
  /value too long/i,
];

// ============================================================================
// Extraction Patterns (top-level for performance)
// ============================================================================

/** Pattern: "relation \"table_name\" does not exist" */
const RELATION_PATTERN = /relation\s+"([^"]+)"/i;

/** Pattern: "insert into table_name" or "update table_name" or "delete from table_name" */
const SQL_OP_PATTERN =
  /(?:insert\s+into|update|delete\s+from)\s+"?([a-z_][a-z0-9_]*)"?/i;

/** Pattern: "on table \"table_name\"" */
const ON_TABLE_PATTERN = /on\s+table\s+"([^"]+)"/i;

/** Pattern: "violates unique constraint \"constraint_name\"" */
const CONSTRAINT_PATTERN = /constraint\s+"([^"]+)"/i;

/** Extract table name from common error message patterns */
const extractTableName = (message: string): string | undefined => {
  const relationMatch = message.match(RELATION_PATTERN);
  if (relationMatch) {
    return relationMatch[1];
  }

  const opMatch = message.match(SQL_OP_PATTERN);
  if (opMatch) {
    return opMatch[1];
  }

  const onTableMatch = message.match(ON_TABLE_PATTERN);
  if (onTableMatch) {
    return onTableMatch[1];
  }

  return undefined;
};

/** Extract constraint name from error messages */
const extractConstraintName = (message: string): string | undefined => {
  const match = message.match(CONSTRAINT_PATTERN);
  return match?.[1];
};

// ============================================================================
// Main Classification Function
// ============================================================================

/**
 * Check if an error object has a PostgreSQL error code
 */
const hasPgCode = (error: unknown): error is { code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof (error as { code: unknown }).code === "string";

/** Error class prefixes for transient errors */
const TRANSIENT_ERROR_CLASSES = ["08", "40", "53", "54", "55", "57", "58"];

/** Error class prefixes for permanent errors */
const PERMANENT_ERROR_CLASSES = ["22", "23", "42"];

/** Context for building classified errors */
interface ClassificationContext {
  errorMessage: string;
  pgCode: string | undefined;
  operation: DbOperation | undefined;
  table: string | undefined;
}

/** Build a transient error result */
const buildTransientError = (
  ctx: ClassificationContext,
  code: string,
  message: string,
  action: string
): ClassifiedDbError => ({
  type: "TRANSIENT",
  code,
  message,
  action,
  pgCode: ctx.pgCode,
  operation: ctx.operation,
  table: ctx.table,
  details: ctx.errorMessage,
});

/** Build a permanent error result */
const buildPermanentError = (
  ctx: ClassificationContext,
  code: string,
  message: string,
  action: string
): ClassifiedDbError => ({
  type: "PERMANENT",
  code,
  message,
  action,
  pgCode: ctx.pgCode,
  operation: ctx.operation,
  table: ctx.table,
  details: ctx.errorMessage,
});

/** Classify error by PostgreSQL error code */
const classifyByPgCode = (
  ctx: ClassificationContext,
  constraintName: string | undefined
): ClassifiedDbError | null => {
  const { pgCode } = ctx;
  if (!pgCode) {
    return null;
  }

  // Check for known transient errors
  if (TRANSIENT_ERROR_CODES.has(pgCode)) {
    const known = TRANSIENT_ERROR_MESSAGES[pgCode];
    return buildTransientError(
      ctx,
      `DB_TRANSIENT_${pgCode}`,
      known?.message ?? "Temporary database error",
      known?.action ?? "Retry the request"
    );
  }

  // Check for known permanent errors
  if (PERMANENT_ERROR_CODES.has(pgCode)) {
    const known = PERMANENT_ERROR_MESSAGES[pgCode];
    let message = known?.message ?? "Database constraint violation";
    if (constraintName && pgCode === "23505") {
      message = `Duplicate record: ${constraintName}`;
    }
    return buildPermanentError(
      ctx,
      `DB_PERMANENT_${pgCode}`,
      message,
      known?.action ?? "Check your data and try again"
    );
  }

  // Class-based fallback
  const errorClass = pgCode.slice(0, 2);
  if (TRANSIENT_ERROR_CLASSES.includes(errorClass)) {
    return buildTransientError(
      ctx,
      `DB_TRANSIENT_${pgCode}`,
      "Temporary database error",
      "Retry the request"
    );
  }
  if (PERMANENT_ERROR_CLASSES.includes(errorClass)) {
    return buildPermanentError(
      ctx,
      `DB_PERMANENT_${pgCode}`,
      "Database error",
      "Check your data and try again"
    );
  }

  return null;
};

/** Classify error by message pattern matching */
const classifyByMessagePattern = (
  ctx: ClassificationContext
): ClassifiedDbError | null => {
  const { errorMessage } = ctx;

  for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return buildTransientError(
        ctx,
        "DB_TRANSIENT_CONNECTION",
        "Database connection error",
        "Retry the request"
      );
    }
  }

  for (const pattern of PERMANENT_MESSAGE_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return buildPermanentError(
        ctx,
        "DB_PERMANENT_CONSTRAINT",
        "Database constraint violation",
        "Check your data and try again"
      );
    }
  }

  return null;
};

/**
 * Classify a database error for actionable error messages
 *
 * @param error - The caught error
 * @param operation - Which DB operation failed
 * @param table - Which table was involved (optional, will attempt to extract)
 * @returns Classified error with type, message, and suggested action
 */
export const classifyDbError = (
  error: unknown,
  operation?: DbOperation,
  table?: string
): ClassifiedDbError => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const pgCode = hasPgCode(error) ? error.code : undefined;
  const detectedTable = table ?? extractTableName(errorMessage);
  const constraintName = extractConstraintName(errorMessage);

  const ctx: ClassificationContext = {
    errorMessage,
    pgCode,
    operation,
    table: detectedTable,
  };

  // Try classification by PG code first (most reliable)
  const byCode = classifyByPgCode(ctx, constraintName);
  if (byCode) {
    return byCode;
  }

  // Fall back to message pattern matching
  const byPattern = classifyByMessagePattern(ctx);
  if (byPattern) {
    return byPattern;
  }

  // Unknown error
  return {
    type: "UNKNOWN",
    code: "DB_UNKNOWN",
    message: "Database operation failed",
    action: "Check server logs for details",
    pgCode,
    operation,
    table: detectedTable,
    details: errorMessage,
  };
};

// ============================================================================
// Custom Error Class
// ============================================================================

/**
 * Database error with classification and diagnostic info
 */
export class DatabaseError extends Error {
  readonly classification: ClassifiedDbError;

  constructor(error: unknown, operation?: DbOperation, table?: string) {
    const classification = classifyDbError(error, operation, table);

    // Build a detailed message for logging
    const parts = [classification.message];
    if (classification.table) {
      parts.push(`(table: ${classification.table})`);
    }
    if (classification.operation) {
      parts.push(`[${classification.operation}]`);
    }

    super(parts.join(" "));
    this.name = "DatabaseError";
    this.classification = classification;

    // Preserve the original stack trace if available
    if (error instanceof Error && error.stack) {
      this.stack = error.stack;
    }
  }

  /** Is this a transient error that can be retried? */
  get isTransient(): boolean {
    return this.classification.type === "TRANSIENT";
  }

  /** Is this a permanent error that should not be retried? */
  get isPermanent(): boolean {
    return this.classification.type === "PERMANENT";
  }

  /** Get the suggested action */
  get action(): string {
    return this.classification.action;
  }

  /** Get the error code for programmatic handling */
  get code(): string {
    return this.classification.code;
  }

  /** Convert to a safe API response (no internal details) */
  toApiResponse(): {
    error: string;
    code: string;
    action: string;
    retryable: boolean;
  } {
    return {
      error: this.classification.message,
      code: this.classification.code,
      action: this.classification.action,
      retryable: this.isTransient,
    };
  }

  /** Convert to a log entry (includes internal details) */
  toLogEntry(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      type: this.classification.type,
      code: this.classification.code,
      pgCode: this.classification.pgCode,
      operation: this.classification.operation,
      table: this.classification.table,
      details: this.classification.details,
      action: this.classification.action,
    };
  }
}

// ============================================================================
// Helper: Wrap Database Operations
// ============================================================================

/**
 * Wrap a database operation with error classification
 *
 * @example
 * const result = await wrapDbOperation(
 *   () => db.insert(runs).values(data),
 *   "insert",
 *   "runs"
 * );
 */
export const wrapDbOperation = async <T>(
  operation: () => Promise<T>,
  opType: DbOperation,
  table?: string
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw new DatabaseError(error, opType, table);
  }
};
