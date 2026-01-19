import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { projects, runErrors, runs } from "../db/schema";
import { apiKeyAuthMiddleware } from "../middleware/api-key-auth";
import { apiKeyRateLimitMiddleware } from "../middleware/api-key-rate-limit";
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
  severity?: "error" | "warning";
  ruleId?: string;
  stackTrace?: string;
  stepId?: string;
  exitCode?: number;
  codeSnippet?: {
    lines: string[];
    startLine: number;
    errorLine: number;
    language: string;
  };
  // Additional fields from ExtractedError
  hint?: string;
  isInfrastructure?: boolean;
  possiblyTestOutput?: boolean;
  fixable?: boolean;
  suggestions?: string[];
  unknownPattern?: boolean;
  lineKnown?: boolean;
  columnKnown?: boolean;
  messageTruncated?: boolean;
  stackTraceTruncated?: boolean;
}

interface ReportPayload {
  runId: number;
  repository: string;
  commitSha: string;
  headBranch: string;
  workflowName: string;
  workflowJob: string;
  runAttempt: number;
  matrix?: Record<string, string>;
  steps: ReportStep[];
  errors: ReportError[];
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
const MAX_SUGGESTIONS = 20;

// Schema-aligned truncation limits (match DB varchar constraints)
const SCHEMA_FILE_PATH_LENGTH = 2048; // run_errors.file_path varchar(2048)
const SCHEMA_CATEGORY_LENGTH = 32; // run_errors.category varchar(32)
const SCHEMA_SEVERITY_LENGTH = 16; // run_errors.severity varchar(16)
const SCHEMA_RULE_ID_LENGTH = 255; // run_errors.rule_id varchar(255)
const SCHEMA_WORKFLOW_JOB_LENGTH = 255; // run_errors.workflow_job varchar(255)
const SCHEMA_WORKFLOW_STEP_LENGTH = 255; // run_errors.workflow_step varchar(255)

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
 * Truncate a string to a maximum length (for storage safety)
 */
const truncate = (val: string, maxLen: number): string =>
  val.length > maxLen ? val.slice(0, maxLen) : val;

/**
 * Truncate an optional string field, returning null if undefined
 */
const truncateOptional = (
  val: string | undefined,
  maxLen: number
): string | null => (val ? truncate(val, maxLen) : null);

/**
 * Convert a ReportError to a database row for run_errors table.
 * Uses schema-aligned truncation limits for all string fields.
 */
const toErrorRow = (
  error: ReportError,
  runId: string,
  workflowJob: string
) => ({
  id: crypto.randomUUID(),
  runId,
  message: truncate(error.message, MAX_LONG_STRING_LENGTH),
  filePath: truncateOptional(error.filePath, SCHEMA_FILE_PATH_LENGTH),
  line: error.line ?? null,
  column: error.column ?? null,
  category: truncateOptional(error.category, SCHEMA_CATEGORY_LENGTH),
  severity: truncateOptional(error.severity, SCHEMA_SEVERITY_LENGTH),
  ruleId: truncateOptional(error.ruleId, SCHEMA_RULE_ID_LENGTH),
  stackTrace: truncateOptional(error.stackTrace, MAX_LONG_STRING_LENGTH),
  workflowJob: truncate(workflowJob, SCHEMA_WORKFLOW_JOB_LENGTH),
  workflowStep: truncateOptional(error.stepId, SCHEMA_WORKFLOW_STEP_LENGTH),
  source: "job-report" as const,
  exitCode: error.exitCode ?? null,
  codeSnippet: error.codeSnippet ?? null,
  hint: truncateOptional(error.hint, MAX_LONG_STRING_LENGTH),
  isInfrastructure: error.isInfrastructure ?? null,
  possiblyTestOutput: error.possiblyTestOutput ?? null,
  fixable: error.fixable ?? null,
  suggestions: error.suggestions ?? null,
  unknownPattern: error.unknownPattern ?? null,
  lineKnown: error.lineKnown ?? null,
  columnKnown: error.columnKnown ?? null,
  messageTruncated: error.messageTruncated ?? null,
  stackTraceTruncated: error.stackTraceTruncated ?? null,
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

const validateRequiredFields = (b: Record<string, unknown>): string | null => {
  // Validate runId
  if (
    typeof b.runId !== "number" ||
    !Number.isInteger(b.runId) ||
    b.runId < 0
  ) {
    return "runId must be a non-negative integer";
  }

  // Validate repository format (owner/repo)
  if (!isNonEmptyString(b.repository)) {
    return "repository must be a non-empty string";
  }
  if (!isValidLength(b.repository, MAX_STRING_LENGTH)) {
    return "repository exceeds maximum length";
  }
  if (!REPOSITORY_PATTERN.test(b.repository)) {
    return "repository must be in format owner/repo";
  }

  // Validate commitSha (40 hex chars)
  if (!isNonEmptyString(b.commitSha)) {
    return "commitSha must be a non-empty string";
  }
  if (!COMMIT_SHA_PATTERN.test(b.commitSha)) {
    return "commitSha must be a valid 40-character hex string";
  }

  // Validate headBranch
  if (!isNonEmptyString(b.headBranch)) {
    return "headBranch must be a non-empty string";
  }
  if (!isValidLength(b.headBranch, MAX_STRING_LENGTH)) {
    return "headBranch exceeds maximum length";
  }

  // Validate workflowName
  if (!isNonEmptyString(b.workflowName)) {
    return "workflowName must be a non-empty string";
  }
  if (!isValidLength(b.workflowName, MAX_STRING_LENGTH)) {
    return "workflowName exceeds maximum length";
  }

  // Validate workflowJob
  if (!isNonEmptyString(b.workflowJob)) {
    return "workflowJob must be a non-empty string";
  }
  if (!isValidLength(b.workflowJob, MAX_STRING_LENGTH)) {
    return "workflowJob exceeds maximum length";
  }

  // Validate runAttempt
  if (
    typeof b.runAttempt !== "number" ||
    !Number.isInteger(b.runAttempt) ||
    b.runAttempt < 1
  ) {
    return "runAttempt must be a positive integer";
  }

  // Validate matrix (optional)
  const matrixError = validateMatrix(b.matrix);
  if (matrixError) {
    return matrixError;
  }

  // Validate arrays
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
 * Validate suggestions array
 * Security: Limits array size and individual string lengths
 */
const validateSuggestions = (
  suggestions: unknown,
  errorIndex: number
): string | null => {
  if (suggestions === undefined || suggestions === null) {
    return null;
  }
  if (!Array.isArray(suggestions)) {
    return `errors[${errorIndex}].suggestions must be an array`;
  }
  if (suggestions.length > MAX_SUGGESTIONS) {
    return `errors[${errorIndex}].suggestions exceeds maximum of ${MAX_SUGGESTIONS} items`;
  }
  for (const [j, suggestion] of suggestions.entries()) {
    if (typeof suggestion !== "string") {
      return `errors[${errorIndex}].suggestions[${j}] must be a string`;
    }
    if (!isValidLength(suggestion, MAX_STRING_LENGTH)) {
      return `errors[${errorIndex}].suggestions[${j}] exceeds maximum length`;
    }
  }
  return null;
};

const BOOLEAN_ERROR_FIELDS = [
  "isInfrastructure",
  "possiblyTestOutput",
  "fixable",
  "unknownPattern",
  "lineKnown",
  "columnKnown",
  "messageTruncated",
  "stackTraceTruncated",
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
    ["exitCode", e.exitCode],
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

  const suggestionsError = validateSuggestions(e.suggestions, i);
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
      matrix: b.matrix as Record<string, string> | undefined,
      steps: b.steps as ReportStep[],
      errors: b.errors as ReportError[],
    },
  };
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

  const { db, client } = await createDb(c.env);
  try {
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.providerRepoFullName, payload.repository),
        eq(projects.organizationId, organizationId),
        isNull(projects.removedAt)
      ),
    });

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    const runRecordId = crypto.randomUUID();
    const runIdStr = String(payload.runId);

    const hasFailure = payload.steps.some((s) => s.conclusion === "failure");
    const conclusion = hasFailure ? "failure" : "success";

    const result = await db.transaction(async (tx) => {
      const [upsertedRun] = await tx
        .insert(runs)
        .values({
          id: runRecordId,
          projectId: project.id,
          provider: "github",
          source: "job-report",
          runId: runIdStr,
          repository: payload.repository,
          commitSha: payload.commitSha,
          headBranch: payload.headBranch,
          workflowName: payload.workflowName,
          runAttempt: payload.runAttempt,
          errorCount: payload.errors.length,
          conclusion,
        })
        .onConflictDoUpdate({
          target: [runs.repository, runs.runId, runs.runAttempt],
          set: {
            errorCount: payload.errors.length,
            conclusion,
          },
        })
        .returning({ id: runs.id });

      if (!upsertedRun?.id) {
        throw new Error("Failed to upsert run");
      }

      if (payload.errors.length > 0) {
        // Delete existing errors for this run/job to avoid duplicates on retry
        await tx
          .delete(runErrors)
          .where(
            and(
              eq(runErrors.runId, upsertedRun.id),
              eq(runErrors.workflowJob, payload.workflowJob),
              eq(runErrors.source, "job-report")
            )
          );

        const errorRows = payload.errors.map((error) =>
          toErrorRow(error, upsertedRun.id, payload.workflowJob)
        );
        await tx.insert(runErrors).values(errorRows);
      }

      return { stored: payload.errors.length, runId: upsertedRun.id };
    });

    return c.json(result);
  } finally {
    await client.end();
  }
});

export default app;
