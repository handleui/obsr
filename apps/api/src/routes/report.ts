import type { HealCreateStatus } from "@detent/types";
import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import {
  createHeal,
  getHealsByPr,
  getHealsByRunId,
} from "../db/operations/heals";
import { getOrgSettings, type OrganizationSettings } from "../lib/org-settings";
import { apiKeyAuthMiddleware } from "../middleware/api-key-auth";
import { apiKeyRateLimitMiddleware } from "../middleware/api-key-rate-limit";
import { hasAutofix } from "../services/autofix/registry";
import { canRunHeal } from "../services/billing";
import type { DbClient } from "../services/webhooks/types";
import type { Env } from "../types/env";

interface ReportStep {
  id: string;
  name?: string;
  outcome: "success" | "failure" | "cancelled" | "skipped";
  conclusion: "success" | "failure" | "cancelled" | "skipped";
}

interface ReportError {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  category?: string;
  source?: string;
  severity?: "error" | "warning";
  ruleId?: string;
  stackTrace?: string;
  stepId?: string;
  codeSnippet?: {
    lines: string[];
    startLine: number;
    errorLine: number;
    language: string;
  };
  // Additional fields from ExtractedError
  possiblyTestOutput?: boolean;
  fixable?: boolean;
  hints?: string[];
  unknownPattern?: boolean;
  lineKnown?: boolean;
  // Backwards compatibility: accept legacy fields and merge into hints
  /** @deprecated Use hints instead */
  suggestions?: string[];
  /** @deprecated Use hints instead */
  hint?: string;
}

interface ReportPayload {
  runId: number;
  repository: string;
  commitSha: string;
  headBranch: string;
  workflowName: string;
  workflowJob: string;
  runAttempt: number;
  prNumber?: number;
  matrix?: Record<string, string>;
  steps: ReportStep[];
  errors: ReportError[];
  isComplete?: boolean;
}

type ValidationResult =
  | { valid: true; payload: ReportPayload }
  | { valid: false; error: string };

// Security: Maximum lengths to prevent memory exhaustion attacks
// These should match or be smaller than the corresponding DB schema constraints
const MAX_STRING_LENGTH = 1024; // General string limit for validation
const MAX_LONG_STRING_LENGTH = 65_536; // For stack traces and error messages
const MAX_STEPS = 1000;
const MAX_ERRORS = 500;
const MAX_MATRIX_ENTRIES = 50;
const MAX_CODE_SNIPPET_LINES = 100;
const MAX_CODE_SNIPPET_LINE_LENGTH = 500;
const MAX_HINTS = 20;

// Schema-aligned truncation limits (match DB varchar constraints)
const SCHEMA_FILE_PATH_LENGTH = 2048; // run_errors.file_path varchar(2048)
const SCHEMA_CATEGORY_LENGTH = 32; // run_errors.category varchar(32)
const SCHEMA_SEVERITY_LENGTH = 16; // run_errors.severity varchar(16)
const SCHEMA_RULE_ID_LENGTH = 255; // run_errors.rule_id varchar(255)
const SCHEMA_WORKFLOW_JOB_LENGTH = 255; // run_errors.workflow_job varchar(255)
const SCHEMA_WORKFLOW_STEP_LENGTH = 255; // run_errors.workflow_step varchar(255)

/**
 * Truncation warning for fields that were cut to fit schema constraints
 */
interface TruncationWarning {
  field: string;
  originalLength: number;
  truncatedTo: number;
}

// Repository format: owner/repo (GitHub format)
const REPOSITORY_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
// Commit SHA: 40 hex characters
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

const isNonEmptyString = (val: unknown): val is string =>
  typeof val === "string" && val.length > 0;

/**
 * Check if a string is within the allowed length
 */
const isValidLength = (val: string, maxLen: number): boolean =>
  val.length <= maxLen;

/**
 * Truncate a string and track if truncation occurred
 */
const truncateWithTracking = (
  val: string,
  maxLen: number,
  fieldPath: string,
  warnings: TruncationWarning[]
): string => {
  if (val.length > maxLen) {
    warnings.push({
      field: fieldPath,
      originalLength: val.length,
      truncatedTo: maxLen,
    });
    return val.slice(0, maxLen);
  }
  return val;
};

/**
 * Truncate an optional string field with tracking, returning null if undefined
 */
const truncateOptionalWithTracking = (
  val: string | undefined,
  maxLen: number,
  fieldPath: string,
  warnings: TruncationWarning[]
): string | null => {
  if (!val) {
    return null;
  }
  return truncateWithTracking(val, maxLen, fieldPath, warnings);
};

/**
 * Convert a ReportError to a database row for run_errors table.
 * Uses schema-aligned truncation limits for all string fields.
 * Returns both the row and any truncation warnings that occurred.
 */
const toErrorRow = (
  error: ReportError,
  runId: string,
  workflowJob: string,
  errorIndex: number
): {
  row: ReturnType<typeof createErrorRow>;
  warnings: TruncationWarning[];
} => {
  const warnings: TruncationWarning[] = [];
  const prefix = `errors[${errorIndex}]`;

  const row = createErrorRow(error, runId, workflowJob, prefix, warnings);
  return { row, warnings };
};

/**
 * Merge legacy hint/suggestions into hints array for backwards compatibility.
 * Incoming data may have: hints, suggestions, hint (singular), or any combination.
 * Output is always a single hints array.
 */
const mergeHints = (error: ReportError): string[] | null => {
  const result: string[] = [];

  // Helper to truncate and add hint if not duplicate
  const addHint = (hint: string) => {
    const truncated = hint.slice(0, MAX_STRING_LENGTH);
    if (!result.includes(truncated)) {
      result.push(truncated);
    }
  };

  // New field takes precedence
  if (error.hints) {
    for (const h of error.hints) {
      addHint(h);
    }
  }

  // Backwards compat: merge legacy suggestions
  if (error.suggestions) {
    for (const s of error.suggestions) {
      addHint(s);
    }
  }

  // Backwards compat: merge legacy singular hint
  if (error.hint) {
    addHint(error.hint);
  }

  return result.length > 0 ? result : null;
};

/**
 * Internal helper to create the error row with truncation tracking
 */
const createErrorRow = (
  error: ReportError,
  runId: string,
  workflowJob: string,
  prefix: string,
  warnings: TruncationWarning[]
) => ({
  runId,
  message: truncateWithTracking(
    error.message,
    MAX_LONG_STRING_LENGTH,
    `${prefix}.message`,
    warnings
  ),
  filePath: truncateOptionalWithTracking(
    error.filePath,
    SCHEMA_FILE_PATH_LENGTH,
    `${prefix}.filePath`,
    warnings
  ),
  line: error.line ?? null,
  column: error.column ?? null,
  category: truncateOptionalWithTracking(
    error.category,
    SCHEMA_CATEGORY_LENGTH,
    `${prefix}.category`,
    warnings
  ),
  severity: truncateOptionalWithTracking(
    error.severity,
    SCHEMA_SEVERITY_LENGTH,
    `${prefix}.severity`,
    warnings
  ),
  ruleId: truncateOptionalWithTracking(
    error.ruleId,
    SCHEMA_RULE_ID_LENGTH,
    `${prefix}.ruleId`,
    warnings
  ),
  stackTrace: truncateOptionalWithTracking(
    error.stackTrace,
    MAX_LONG_STRING_LENGTH,
    `${prefix}.stackTrace`,
    warnings
  ),
  workflowJob: truncateWithTracking(
    workflowJob,
    SCHEMA_WORKFLOW_JOB_LENGTH,
    "workflowJob",
    warnings
  ),
  workflowStep: truncateOptionalWithTracking(
    error.stepId,
    SCHEMA_WORKFLOW_STEP_LENGTH,
    `${prefix}.stepId`,
    warnings
  ),
  source: "job-report" as const,
  codeSnippet: error.codeSnippet ?? null,
  possiblyTestOutput: error.possiblyTestOutput ?? null,
  fixable: error.fixable ?? null,
  hints: mergeHints(error),
  unknownPattern: error.unknownPattern ?? null,
  lineKnown: error.lineKnown ?? null,
  createdAt: Date.now(),
});

/**
 * Validate matrix field (optional Record<string, string>)
 * Security: Limits entries and string lengths to prevent memory exhaustion
 */
const validateMatrix = (matrix: unknown): string | null => {
  if (matrix === undefined || matrix === null) {
    return null;
  }
  if (typeof matrix !== "object" || Array.isArray(matrix)) {
    return "matrix must be an object";
  }
  const entries = Object.entries(matrix as Record<string, unknown>);
  if (entries.length > MAX_MATRIX_ENTRIES) {
    return `matrix exceeds maximum of ${MAX_MATRIX_ENTRIES} entries`;
  }
  for (const [key, value] of entries) {
    if (!isValidLength(key, MAX_STRING_LENGTH)) {
      return "matrix key exceeds maximum length";
    }
    if (typeof value !== "string") {
      return "matrix values must be strings";
    }
    if (!isValidLength(value, MAX_STRING_LENGTH)) {
      return "matrix value exceeds maximum length";
    }
  }
  return null;
};

const validateRunId = (b: Record<string, unknown>): string | null => {
  if (
    typeof b.runId !== "number" ||
    !Number.isInteger(b.runId) ||
    b.runId < 0
  ) {
    return "runId must be a non-negative integer";
  }
  return null;
};

const validateRepository = (b: Record<string, unknown>): string | null => {
  if (!isNonEmptyString(b.repository)) {
    return "repository must be a non-empty string";
  }
  if (!isValidLength(b.repository, MAX_STRING_LENGTH)) {
    return "repository exceeds maximum length";
  }
  if (!REPOSITORY_PATTERN.test(b.repository)) {
    return "repository must be in format owner/repo";
  }
  return null;
};

const validateCommitSha = (b: Record<string, unknown>): string | null => {
  if (!isNonEmptyString(b.commitSha)) {
    return "commitSha must be a non-empty string";
  }
  if (!COMMIT_SHA_PATTERN.test(b.commitSha)) {
    return "commitSha must be a valid 40-character hex string";
  }
  return null;
};

const validateStringField = (
  b: Record<string, unknown>,
  field: string,
  label: string
): string | null => {
  const val = b[field];
  if (!isNonEmptyString(val)) {
    return `${label} must be a non-empty string`;
  }
  if (!isValidLength(val, MAX_STRING_LENGTH)) {
    return `${label} exceeds maximum length`;
  }
  return null;
};

const validatePrNumber = (b: Record<string, unknown>): string | null => {
  if (b.prNumber === undefined) {
    return null;
  }
  if (typeof b.prNumber !== "number" || !Number.isInteger(b.prNumber)) {
    return "prNumber must be an integer";
  }
  if (b.prNumber <= 0) {
    return "prNumber must be a positive integer";
  }
  return null;
};

const validateRequiredFields = (b: Record<string, unknown>): string | null => {
  let error = validateRunId(b);
  if (error) {
    return error;
  }

  error = validateRepository(b);
  if (error) {
    return error;
  }

  error = validateCommitSha(b);
  if (error) {
    return error;
  }

  error = validateStringField(b, "headBranch", "headBranch");
  if (error) {
    return error;
  }

  error = validateStringField(b, "workflowName", "workflowName");
  if (error) {
    return error;
  }

  error = validateStringField(b, "workflowJob", "workflowJob");
  if (error) {
    return error;
  }

  if (
    typeof b.runAttempt !== "number" ||
    !Number.isInteger(b.runAttempt) ||
    b.runAttempt < 1
  ) {
    return "runAttempt must be a positive integer";
  }

  error = validatePrNumber(b);
  if (error) {
    return error;
  }

  const matrixError = validateMatrix(b.matrix);
  if (matrixError) {
    return matrixError;
  }

  if (!Array.isArray(b.steps)) {
    return "steps must be an array";
  }
  if (b.steps.length > MAX_STEPS) {
    return `steps array exceeds maximum size of ${MAX_STEPS}`;
  }

  if (!Array.isArray(b.errors)) {
    return "errors must be an array";
  }
  if (b.errors.length > MAX_ERRORS) {
    return `errors array exceeds maximum size of ${MAX_ERRORS}`;
  }

  return null;
};

const VALID_OUTCOMES = ["success", "failure", "cancelled", "skipped"] as const;
const VALID_SEVERITIES = ["error", "warning"] as const;

const isValidOutcome = (val: unknown): val is (typeof VALID_OUTCOMES)[number] =>
  typeof val === "string" &&
  VALID_OUTCOMES.includes(val as (typeof VALID_OUTCOMES)[number]);

const validateStep = (s: Record<string, unknown>, i: number): string | null => {
  if (!isNonEmptyString(s.id)) {
    return `steps[${i}].id must be a non-empty string`;
  }
  if (!isValidLength(s.id, MAX_STRING_LENGTH)) {
    return `steps[${i}].id exceeds maximum length`;
  }
  if (s.name !== undefined) {
    if (typeof s.name !== "string") {
      return `steps[${i}].name must be a string`;
    }
    if (!isValidLength(s.name, MAX_STRING_LENGTH)) {
      return `steps[${i}].name exceeds maximum length`;
    }
  }
  if (!isValidOutcome(s.outcome)) {
    return `steps[${i}].outcome must be one of: ${VALID_OUTCOMES.join(", ")}`;
  }
  if (!isValidOutcome(s.conclusion)) {
    return `steps[${i}].conclusion must be one of: ${VALID_OUTCOMES.join(", ")}`;
  }
  return null;
};

const validateSteps = (steps: unknown[]): string | null => {
  for (const [i, step] of steps.entries()) {
    if (!step || typeof step !== "object") {
      return `steps[${i}] must be an object`;
    }
    const error = validateStep(step as Record<string, unknown>, i);
    if (error) {
      return error;
    }
  }
  return null;
};

/**
 * Validate codeSnippet structure and content
 * Security: Prevents memory exhaustion via oversized arrays or strings
 */
const validateCodeSnippet = (
  snippet: unknown,
  errorIndex: number
): string | null => {
  if (snippet === undefined || snippet === null) {
    return null;
  }
  if (typeof snippet !== "object" || Array.isArray(snippet)) {
    return `errors[${errorIndex}].codeSnippet must be an object`;
  }
  const s = snippet as Record<string, unknown>;

  // Validate lines array
  if (!Array.isArray(s.lines)) {
    return `errors[${errorIndex}].codeSnippet.lines must be an array`;
  }
  if (s.lines.length > MAX_CODE_SNIPPET_LINES) {
    return `errors[${errorIndex}].codeSnippet.lines exceeds maximum of ${MAX_CODE_SNIPPET_LINES}`;
  }
  for (const [j, line] of s.lines.entries()) {
    if (typeof line !== "string") {
      return `errors[${errorIndex}].codeSnippet.lines[${j}] must be a string`;
    }
    if (line.length > MAX_CODE_SNIPPET_LINE_LENGTH) {
      return `errors[${errorIndex}].codeSnippet.lines[${j}] exceeds maximum length`;
    }
  }

  // Validate numeric fields
  if (typeof s.startLine !== "number" || !Number.isInteger(s.startLine)) {
    return `errors[${errorIndex}].codeSnippet.startLine must be an integer`;
  }
  if (typeof s.errorLine !== "number" || !Number.isInteger(s.errorLine)) {
    return `errors[${errorIndex}].codeSnippet.errorLine must be an integer`;
  }

  // Validate language
  if (typeof s.language !== "string") {
    return `errors[${errorIndex}].codeSnippet.language must be a string`;
  }
  if (!isValidLength(s.language, MAX_STRING_LENGTH)) {
    return `errors[${errorIndex}].codeSnippet.language exceeds maximum length`;
  }

  return null;
};

/**
 * Validate a string array field (hints or legacy suggestions)
 * Security: Limits array size and individual string lengths
 */
const validateStringArray = (
  arr: unknown,
  fieldName: string,
  errorIndex: number
): string | null => {
  if (arr === undefined || arr === null) {
    return null;
  }
  if (!Array.isArray(arr)) {
    return `errors[${errorIndex}].${fieldName} must be an array`;
  }
  if (arr.length > MAX_HINTS) {
    return `errors[${errorIndex}].${fieldName} exceeds maximum of ${MAX_HINTS} items`;
  }
  for (const [j, item] of arr.entries()) {
    if (typeof item !== "string") {
      return `errors[${errorIndex}].${fieldName}[${j}] must be a string`;
    }
    if (!isValidLength(item, MAX_STRING_LENGTH)) {
      return `errors[${errorIndex}].${fieldName}[${j}] exceeds maximum length`;
    }
  }
  return null;
};

const BOOLEAN_ERROR_FIELDS = [
  "possiblyTestOutput",
  "fixable",
  "unknownPattern",
  "lineKnown",
];

/**
 * Validate a single error object's string fields
 */
const validateErrorStrings = (
  e: Record<string, unknown>,
  i: number
): string | null => {
  if (!isNonEmptyString(e.message)) {
    return `errors[${i}].message must be a non-empty string`;
  }
  if (!isValidLength(e.message, MAX_LONG_STRING_LENGTH)) {
    return `errors[${i}].message exceeds maximum length`;
  }

  const stringChecks: [string, unknown, number][] = [
    ["stackTrace", e.stackTrace, MAX_LONG_STRING_LENGTH],
    ["filePath", e.filePath, SCHEMA_FILE_PATH_LENGTH],
    ["category", e.category, SCHEMA_CATEGORY_LENGTH],
    ["ruleId", e.ruleId, SCHEMA_RULE_ID_LENGTH],
    ["stepId", e.stepId, SCHEMA_WORKFLOW_STEP_LENGTH],
    // Legacy hint field - still accept for backwards compatibility
    ["hint", e.hint, MAX_LONG_STRING_LENGTH],
  ];

  for (const [name, value, maxLen] of stringChecks) {
    if (
      value !== undefined &&
      typeof value === "string" &&
      !isValidLength(value, maxLen)
    ) {
      return `errors[${i}].${name} exceeds maximum length`;
    }
  }

  if (
    e.severity !== undefined &&
    (typeof e.severity !== "string" ||
      !VALID_SEVERITIES.includes(
        e.severity as (typeof VALID_SEVERITIES)[number]
      ))
  ) {
    return `errors[${i}].severity must be one of: ${VALID_SEVERITIES.join(", ")}`;
  }

  return null;
};

/**
 * Validate a single error object's numeric and boolean fields
 */
const validateErrorPrimitives = (
  e: Record<string, unknown>,
  i: number
): string | null => {
  const numericFields: [string, unknown][] = [
    ["line", e.line],
    ["column", e.column],
  ];

  for (const [name, value] of numericFields) {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "number" || !Number.isInteger(value))
    ) {
      return `errors[${i}].${name} must be an integer`;
    }
  }

  for (const field of BOOLEAN_ERROR_FIELDS) {
    if (
      e[field] !== undefined &&
      e[field] !== null &&
      typeof e[field] !== "boolean"
    ) {
      return `errors[${i}].${field} must be a boolean`;
    }
  }

  return null;
};

/**
 * Validate a single error object
 */
const validateError = (
  e: Record<string, unknown>,
  i: number
): string | null => {
  const stringError = validateErrorStrings(e, i);
  if (stringError) {
    return stringError;
  }

  const primitiveError = validateErrorPrimitives(e, i);
  if (primitiveError) {
    return primitiveError;
  }

  const snippetError = validateCodeSnippet(e.codeSnippet, i);
  if (snippetError) {
    return snippetError;
  }

  // Validate hints array (new field)
  const hintsError = validateStringArray(e.hints, "hints", i);
  if (hintsError) {
    return hintsError;
  }

  // Validate legacy suggestions array (backwards compatibility)
  const suggestionsError = validateStringArray(e.suggestions, "suggestions", i);
  if (suggestionsError) {
    return suggestionsError;
  }

  return null;
};

const validateErrors = (errors: unknown[]): string | null => {
  for (const [i, error] of errors.entries()) {
    if (!error || typeof error !== "object") {
      return `errors[${i}] must be an object`;
    }
    const result = validateError(error as Record<string, unknown>, i);
    if (result) {
      return result;
    }
  }
  return null;
};

const validatePayload = (body: unknown): ValidationResult => {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be an object" };
  }

  const b = body as Record<string, unknown>;

  const fieldError = validateRequiredFields(b);
  if (fieldError) {
    return { valid: false, error: fieldError };
  }

  const stepsError = validateSteps(b.steps as unknown[]);
  if (stepsError) {
    return { valid: false, error: stepsError };
  }

  const errorsError = validateErrors(b.errors as unknown[]);
  if (errorsError) {
    return { valid: false, error: errorsError };
  }

  return {
    valid: true,
    payload: {
      runId: b.runId as number,
      repository: b.repository as string,
      commitSha: b.commitSha as string,
      headBranch: b.headBranch as string,
      workflowName: b.workflowName as string,
      workflowJob: b.workflowJob as string,
      runAttempt: b.runAttempt as number,
      prNumber: b.prNumber as number | undefined,
      matrix: b.matrix as Record<string, string> | undefined,
      steps: b.steps as ReportStep[],
      errors: b.errors as ReportError[],
      isComplete: b.isComplete === true ? true : undefined,
    },
  };
};

// Import job tracking functions
import { checkAndTriggerAggregation } from "../services/webhooks/job-aggregation";
import {
  markJobAsDetent,
  updateCommitJobStats,
} from "../services/webhooks/job-operations";

/**
 * Mark job as Detent-enabled and trigger aggregation check.
 * Comment is only posted when ALL jobs for the commit are complete.
 */
const handleJobCompletion = async (
  env: Env,
  db: DbClient,
  repository: string,
  commitSha: string,
  workflowJob: string,
  errorCount: number
): Promise<{ commentPosted: boolean; allJobsComplete: boolean }> => {
  try {
    // Mark this job as having Detent action and set error count
    const jobFound = await markJobAsDetent(
      db,
      repository,
      commitSha,
      workflowJob,
      errorCount
    );

    if (!jobFound) {
      // Job record doesn't exist yet (webhook hasn't arrived)
      // This is expected in some cases - the aggregation will happen
      // when the workflow_job webhook arrives
      console.log(
        `[report] Job ${workflowJob} not found for ${repository}@${commitSha.slice(0, 7)}, will aggregate later`
      );
      return { commentPosted: false, allJobsComplete: false };
    }

    // Update aggregated stats
    await updateCommitJobStats(db, repository, commitSha);

    // Check if all jobs are complete and post comment if so
    const aggregation = await checkAndTriggerAggregation(
      env,
      db,
      repository,
      commitSha
    );

    return {
      commentPosted: aggregation.commentPosted,
      allJobsComplete: aggregation.allComplete,
    };
  } catch (error) {
    console.error(
      `[report] Error in job completion handling for ${repository}:`,
      error instanceof Error ? error.message : String(error)
    );
    return { commentPosted: false, allJobsComplete: false };
  }
};

const isErrorAutofixable = (error: {
  fixable?: boolean | null;
  source?: string | null;
}): boolean => {
  if (error.fixable !== true) {
    return false;
  }
  const source = typeof error.source === "string" ? error.source : "";
  return source.length > 0 && hasAutofix(source);
};

interface RunError {
  _id: string;
  fixable?: boolean | null;
  category?: string | null;
  source?: string | null;
  signatureId?: string | null;
  workflowJob?: string | null;
}

const groupErrorsByWorkflowJob = (
  runErrors: RunError[]
): Map<string, RunError[]> => {
  const errorsByWorkflowJob = new Map<string, RunError[]>();
  for (const error of runErrors) {
    if (typeof error.workflowJob !== "string" || !error.workflowJob) {
      continue;
    }
    if (isErrorAutofixable(error)) {
      continue;
    }
    const existingGroup = errorsByWorkflowJob.get(error.workflowJob) ?? [];
    existingGroup.push(error);
    errorsByWorkflowJob.set(error.workflowJob, existingGroup);
  }
  return errorsByWorkflowJob;
};

const createHealsForErrors = async (
  env: Env,
  convex: DbClient,
  project: { _id: string; organizationId: string },
  payload: ReportPayload,
  storeResult: { runId: string }
): Promise<void> => {
  if (payload.errors.length === 0) {
    return;
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as { settings?: OrganizationSettings | null } | null;
  const orgSettings = getOrgSettings(organization?.settings);

  const healsByRun = await getHealsByRunId(env, storeResult.runId);
  const healsByPr = payload.prNumber
    ? await getHealsByPr(env, project._id, payload.prNumber)
    : [];
  const existingHeals = [...healsByRun, ...healsByPr];
  const existingErrorIds = new Set(
    existingHeals
      .filter((heal) => heal.type === "heal")
      .flatMap((heal) => heal.errorIds ?? [])
  );

  const errorLimit = 1000;
  const runErrors = (await convex.query("run-errors:listByRunId", {
    runId: storeResult.runId,
    limit: errorLimit,
  })) as RunError[];

  if (runErrors.length === errorLimit) {
    console.warn(
      `[createHealsForErrors] Run ${storeResult.runId} has ${errorLimit}+ errors; some may not be considered for heal creation`
    );
  }

  const errorsByWorkflowJob = groupErrorsByWorkflowJob(runErrors);

  let healStatus: HealCreateStatus = "found";
  if (orgSettings.healAutoTrigger) {
    const billingCheck = await canRunHeal(env, project.organizationId);
    if (billingCheck.allowed) {
      healStatus = "pending";
    }
  }

  const healCreationPromises: Promise<string>[] = [];
  for (const errors of errorsByWorkflowJob.values()) {
    const errorIds = errors.map((error) => error._id);
    if (errorIds.length === 0) {
      continue;
    }
    if (errorIds.some((id) => existingErrorIds.has(id))) {
      continue;
    }

    const signatureIds = errors
      .map((error) => error.signatureId)
      .filter((id): id is string => typeof id === "string");

    healCreationPromises.push(
      createHeal(env, {
        type: "heal",
        status: healStatus,
        projectId: project._id,
        runId: storeResult.runId,
        commitSha: payload.commitSha,
        prNumber: payload.prNumber,
        errorIds,
        signatureIds,
      })
    );
  }

  if (healCreationPromises.length > 0) {
    try {
      await Promise.all(healCreationPromises);
    } catch (error) {
      console.error("Failed to create heal records:", error);
    }
  }
};

const app = new Hono<{ Bindings: Env }>();

app.use("*", apiKeyAuthMiddleware);
app.use("*", apiKeyRateLimitMiddleware);

app.post("/", async (c) => {
  const { organizationId } = c.get("apiKeyAuth");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const validation = validatePayload(body);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const payload = validation.payload;

  const convex = getConvexClient(c.env);
  try {
    const project = (await convex.query("projects:getByRepoFullName", {
      providerRepoFullName: payload.repository,
    })) as {
      _id: string;
      organizationId: string;
      removedAt?: number | null;
    } | null;

    if (
      !project ||
      project.removedAt ||
      project.organizationId !== organizationId
    ) {
      return c.json({ error: "Project not found" }, 404);
    }

    const runRecordId = crypto.randomUUID();
    const runIdStr = String(payload.runId);

    const hasFailure = payload.steps.some((s) => s.conclusion === "failure");
    const conclusion = hasFailure ? "failure" : "success";

    const allWarnings: TruncationWarning[] = [];
    const errorRows = payload.errors.map((error, index) => {
      const { row, warnings } = toErrorRow(
        error,
        runRecordId,
        payload.workflowJob,
        index
      );
      allWarnings.push(...warnings);
      return row;
    });

    const storeResult = (await convex.mutation("run-ingest:storeJobReport", {
      run: {
        id: runRecordId,
        projectId: project._id,
        provider: "github",
        source: "job-report",
        runId: runIdStr,
        repository: payload.repository,
        commitSha: payload.commitSha,
        headBranch: payload.headBranch,
        prNumber: payload.prNumber,
        workflowName: payload.workflowName,
        runAttempt: payload.runAttempt,
        errorCount: payload.errors.length,
        conclusion,
        receivedAt: Date.now(),
      },
      errors: errorRows,
      workflowJob: payload.workflowJob,
      source: "job-report",
    })) as { runId: string };

    if (allWarnings.length > 0) {
      console.warn(
        `[report] Truncation occurred for run ${storeResult.runId}:`,
        JSON.stringify(allWarnings)
      );
    }

    await createHealsForErrors(c.env, convex, project, payload, storeResult);

    const stored = payload.errors.length;

    // Handle job completion: mark as Detent-enabled and check aggregation
    const { commentPosted } =
      payload.isComplete === true && stored > 0
        ? await handleJobCompletion(
            c.env,
            convex,
            payload.repository,
            payload.commitSha,
            payload.workflowJob,
            stored
          )
        : { commentPosted: false };

    const response: {
      stored: number;
      runId: string;
      warnings?: TruncationWarning[];
      commentPosted?: boolean;
    } = {
      stored,
      runId: storeResult.runId,
    };
    if (allWarnings.length > 0) {
      response.warnings = allWarnings;
    }
    if (payload.isComplete === true) {
      response.commentPosted = commentPosted;
    }

    return c.json(response);
  } catch (error) {
    console.error("[report] Error processing report:", error);
    return c.json(
      {
        message: "report error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default app;
