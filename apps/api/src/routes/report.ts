import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { projects, runErrors, runs } from "../db/schema";
import { apiKeyAuthMiddleware } from "../middleware/api-key-auth";
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

const isNonEmptyString = (val: unknown): val is string =>
  typeof val === "string" && val.length > 0;

const validateRequiredFields = (b: Record<string, unknown>): string | null => {
  if (typeof b.runId !== "number") {
    return "runId must be a number";
  }
  if (!isNonEmptyString(b.repository)) {
    return "repository must be a non-empty string";
  }
  if (!isNonEmptyString(b.commitSha)) {
    return "commitSha must be a non-empty string";
  }
  if (!isNonEmptyString(b.headBranch)) {
    return "headBranch must be a non-empty string";
  }
  if (!isNonEmptyString(b.workflowName)) {
    return "workflowName must be a non-empty string";
  }
  if (!isNonEmptyString(b.workflowJob)) {
    return "workflowJob must be a non-empty string";
  }
  if (typeof b.runAttempt !== "number") {
    return "runAttempt must be a number";
  }
  if (!Array.isArray(b.steps)) {
    return "steps must be an array";
  }
  if (!Array.isArray(b.errors)) {
    return "errors must be an array";
  }
  return null;
};

const validateSteps = (steps: unknown[]): string | null => {
  for (const [i, step] of steps.entries()) {
    if (!step || typeof step !== "object") {
      return `steps[${i}] must be an object`;
    }
    const s = step as Record<string, unknown>;
    if (!isNonEmptyString(s.id)) {
      return `steps[${i}].id must be a non-empty string`;
    }
  }
  return null;
};

const validateErrors = (errors: unknown[]): string | null => {
  for (const [i, error] of errors.entries()) {
    if (!error || typeof error !== "object") {
      return `errors[${i}] must be an object`;
    }
    const e = error as Record<string, unknown>;
    if (!isNonEmptyString(e.message)) {
      return `errors[${i}].message must be a non-empty string`;
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

    await db
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
      });

    const existingRun = await db.query.runs.findFirst({
      where: and(
        eq(runs.repository, payload.repository),
        eq(runs.runId, runIdStr),
        eq(runs.runAttempt, payload.runAttempt)
      ),
    });

    const finalRunId = existingRun?.id ?? runRecordId;

    if (payload.errors.length > 0) {
      const errorRows = payload.errors.map((error) => ({
        id: crypto.randomUUID(),
        runId: finalRunId,
        message: error.message,
        filePath: error.filePath ?? null,
        line: error.line ?? null,
        column: error.column ?? null,
        category: error.category ?? null,
        severity: error.severity ?? null,
        ruleId: error.ruleId ?? null,
        stackTrace: error.stackTrace ?? null,
        workflowJob: payload.workflowJob,
        workflowStep: error.stepId ?? null,
        source: "job-report",
        exitCode: error.exitCode ?? null,
      }));

      await db.insert(runErrors).values(errorRows);
    }

    return c.json({
      stored: payload.errors.length,
      runId: finalRunId,
    });
  } finally {
    await client.end();
  }
});

export default app;
