import { type createDb, runErrorOps, runOps } from "@detent/db";
import { scrubSecrets } from "@detent/types";
import { type Context, Hono } from "hono";
import { getConvexClient } from "../db/convex";
import { getDb } from "../lib/db.js";
import { verifyOrgAccess } from "../lib/org-access";
import type { Env } from "../types/env";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PREFIX_RUNS = 5000;

const app = new Hono<{ Bindings: Env }>();

interface ProjectDoc {
  _id: string;
  organizationId: string;
  providerRepoFullName?: string;
  removedAt?: number;
}

interface OrganizationDoc {
  _id: string;
  name: string;
  slug: string;
  provider: "github" | "gitlab";
  providerAccountLogin: string;
  providerAccountId: string;
  providerAccountType: "organization" | "user";
  providerInstallationId?: string;
  installerGithubId?: string;
  suspendedAt?: number;
  deletedAt?: number;
}

const verifyProjectOrgAccess = async (
  c: Context<{ Bindings: Env }>,
  projectOrgId: string
): Promise<{ error: string; status: 403 } | null> => {
  const apiKeyAuth = c.get("apiKeyAuth");
  if (apiKeyAuth) {
    if (projectOrgId !== apiKeyAuth.organizationId) {
      return { error: "Access denied", status: 403 };
    }
    return null;
  }

  const auth = c.get("auth");
  const convex = getConvexClient(c.env);
  const organization = (await convex.query("organizations:getById", {
    id: projectOrgId,
  })) as OrganizationDoc | null;
  if (!organization) {
    // Generic 403 to avoid revealing whether the org exists
    return { error: "Access denied", status: 403 };
  }
  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    // Generic message — do not forward access.error (may leak membership details)
    return { error: "Access denied", status: 403 };
  }
  return null;
};

interface RunDoc {
  id: string;
  runId: string;
  workflowName?: string | null;
  conclusion?: string | null;
  runAttempt: number;
  errorCount?: number | null;
  commitSha?: string | null;
  headBranch?: string | null;
  runCompletedAt?: number | null;
  repository: string;
}

interface RunErrorDoc {
  id: string;
  runId: string;
  filePath?: string | null;
  line?: number | null;
  column?: number | null;
  message: string;
  category?: string | null;
  severity?: string | null;
  source?: string | null;
  ruleId?: string | null;
  hints?: string[] | null;
  stackTrace?: string | null;
  codeSnippet?: {
    lines: string[];
    startLine: number;
    errorLine: number;
    language: string;
  } | null;
  fixable?: boolean | null;
  relatedFiles?: string[] | null;
  workflowJob?: string | null;
  workflowContext?: {
    job?: string | null;
    step?: string | null;
    action?: string | null;
  } | null;
  logLineStart?: number | null;
  logLineEnd?: number | null;
  createdAt: number;
}

const validateCommitQuery = (
  commitParam: string | undefined,
  repository: string | undefined
):
  | { valid: true; commit: string; repository: string }
  | { valid: false; error: string } => {
  if (!commitParam) {
    return { valid: false, error: "commit query parameter is required" };
  }
  if (!repository) {
    return { valid: false, error: "repository query parameter is required" };
  }
  if (!COMMIT_SHA_PATTERN.test(commitParam)) {
    return {
      valid: false,
      error: "Invalid commit SHA format (expected 7-40 hex characters)",
    };
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    return {
      valid: false,
      error: "Invalid repository format (expected 'owner/repo')",
    };
  }
  return { valid: true, commit: commitParam, repository };
};

const fetchCommitRuns = async (
  db: ReturnType<typeof createDb>["db"],
  repository: string,
  normalizedCommit: string
): Promise<
  { runs: RunDoc[]; truncated: boolean } | { error: string; status: 400 | 404 }
> => {
  if (normalizedCommit.length === 40) {
    const runs = (await runOps.listByRepoCommit(
      db,
      repository,
      normalizedCommit
    )) as RunDoc[];
    return { runs, truncated: false };
  }

  const result = await runOps.listByRepoCommitPrefix(
    db,
    repository,
    normalizedCommit,
    MAX_PREFIX_RUNS
  );
  return { runs: result.runs as RunDoc[], truncated: result.isTruncated };
};

const validateCommitAmbiguity = (
  commitRuns: RunDoc[],
  normalizedCommit: string
): { error: string; status: 400 } | null => {
  const commitShas = commitRuns
    .map((r) => r.commitSha)
    .filter((value): value is string => Boolean(value));
  const distinctCommits = new Set(commitShas);

  if (distinctCommits.size > 1) {
    return {
      error: `Ambiguous commit SHA: '${normalizedCommit}' matches ${distinctCommits.size} different commits. Please use a longer SHA prefix.`,
      status: 400,
    };
  }
  return null;
};

const deduplicateRunsByLatestAttempt = (commitRuns: RunDoc[]): RunDoc[] => {
  // Single pass: keep the run with the highest attempt per runId (avoids sort)
  const latestRunsMap = new Map<string, RunDoc>();
  for (const run of commitRuns) {
    if (!run.runId) {
      continue;
    }
    const existing = latestRunsMap.get(run.runId);
    if (!existing || run.runAttempt > existing.runAttempt) {
      latestRunsMap.set(run.runId, run);
    }
  }
  return Array.from(latestRunsMap.values());
};

const formatRunResponse = (r: RunDoc) => ({
  id: r.id,
  runId: r.runId,
  workflowName: r.workflowName,
  conclusion: r.conclusion,
  runAttempt: r.runAttempt,
  errorCount: r.errorCount,
  headBranch: r.headBranch,
  completedAt: r.runCompletedAt
    ? new Date(r.runCompletedAt).toISOString()
    : null,
});

// Only call scrubSecrets on non-empty strings to avoid unnecessary work
const scrubField = (value: string | null | undefined): string | null =>
  value ? scrubSecrets(value) : null;

const formatErrorResponse = (e: RunErrorDoc) => ({
  id: e.id,
  filePath: e.filePath,
  line: e.line,
  column: e.column,
  message: scrubSecrets(e.message),
  category: e.category,
  severity: e.severity,
  source: e.source,
  ruleId: e.ruleId,
  hints: e.hints ? e.hints.map(scrubSecrets) : null,
  stackTrace: scrubField(e.stackTrace),
  codeSnippet: e.codeSnippet
    ? {
        ...e.codeSnippet,
        lines: e.codeSnippet.lines.map(scrubSecrets),
      }
    : null,
  fixable: e.fixable ?? false,
  relatedFiles: e.relatedFiles ?? null,
  workflowJob: scrubField(e.workflowJob),
  workflowContext: {
    job: scrubField(e.workflowJob),
    step: e.workflowContext ? scrubField(e.workflowContext.step) : null,
    action: e.workflowContext ? scrubField(e.workflowContext.action) : null,
  },
  logLineStart: e.logLineStart ?? null,
  logLineEnd: e.logLineEnd ?? null,
  createdAt: new Date(e.createdAt).toISOString(),
});

app.get("/", async (c) => {
  const commitParam = c.req.query("commit");
  const repository = c.req.query("repository");

  const validated = validateCommitQuery(commitParam, repository);
  if (!validated.valid) {
    return c.json({ error: validated.error }, 400);
  }

  const convex = getConvexClient(c.env);
  const project = (await convex.query("projects:getByRepoFullName", {
    providerRepoFullName: validated.repository,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Repository not found or not linked" }, 404);
  }

  const accessError = await verifyProjectOrgAccess(c, project.organizationId);
  if (accessError) {
    return c.json({ error: accessError.error }, accessError.status);
  }

  const { db, pool } = getDb(c.env);
  try {
    const normalizedCommit = validated.commit.toLowerCase();
    const fetchResult = await fetchCommitRuns(
      db,
      validated.repository,
      normalizedCommit
    );

    if ("error" in fetchResult) {
      return c.json({ error: fetchResult.error }, fetchResult.status);
    }

    if (fetchResult.runs.length === 0) {
      return c.json({ error: "No CI runs found for this commit" }, 404);
    }

    if (fetchResult.truncated) {
      return c.json(
        {
          error:
            "Commit SHA prefix matches too many runs. Please use a longer SHA prefix.",
        },
        400
      );
    }

    const ambiguityError = validateCommitAmbiguity(
      fetchResult.runs,
      normalizedCommit
    );
    if (ambiguityError) {
      return c.json({ error: ambiguityError.error }, ambiguityError.status);
    }

    const fullCommitSha =
      fetchResult.runs.find((r) => r.commitSha)?.commitSha ?? normalizedCommit;
    const latestRuns = deduplicateRunsByLatestAttempt(fetchResult.runs);

    const errors = (await runErrorOps.listByRunIds(
      db,
      latestRuns.map((r) => r.id),
      5000
    )) as RunErrorDoc[];

    // Short cache for SDK consumers — errors are immutable once stored,
    // but new runs may appear, so keep TTL low
    c.header("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
    return c.json({
      commit: fullCommitSha,
      repository: validated.repository,
      runs: latestRuns.map(formatRunResponse),
      errors: errors.map(formatErrorResponse),
    });
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
});

app.get("/pr", async (c) => {
  const projectId = c.req.query("projectId");
  const prNumberStr = c.req.query("prNumber");

  if (!projectId) {
    return c.json({ error: "projectId query parameter is required" }, 400);
  }

  if (!prNumberStr) {
    return c.json({ error: "prNumber query parameter is required" }, 400);
  }

  const prNumber = Number.parseInt(prNumberStr, 10);
  if (Number.isNaN(prNumber) || prNumber <= 0 || prNumber > 2_147_483_647) {
    return c.json({ error: "prNumber must be a positive integer" }, 400);
  }

  const convex = getConvexClient(c.env);
  const project = (await convex.query("projects:getById", {
    id: projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const accessError = await verifyProjectOrgAccess(c, project.organizationId);
  if (accessError) {
    return c.json({ error: accessError.error }, accessError.status);
  }

  const { db, pool } = getDb(c.env);
  try {
    const run = await runOps.getLatestByProjectPr(db, projectId, prNumber);
    if (!run) {
      return c.json(
        {
          commit: null,
          repository: project.providerRepoFullName ?? null,
          runs: [],
          errors: [],
        },
        200
      );
    }

    const runDoc = run as RunDoc;
    const errors = (await runErrorOps.listByRunId(
      db,
      run.id,
      1000
    )) as RunErrorDoc[];

    c.header("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
    return c.json({
      commit: runDoc.commitSha ?? null,
      repository: runDoc.repository,
      runs: [formatRunResponse(runDoc)],
      errors: errors.map(formatErrorResponse),
    });
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
});

export default app;
