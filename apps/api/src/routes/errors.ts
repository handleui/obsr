/**
 * Errors API routes
 *
 * Provides access to CI errors for a commit, used by the CLI `detent errors` command.
 */

import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import { verifyOrgAccess } from "../lib/org-access";
import { scrubSecrets } from "../lib/scrub-secrets";
import type { Env } from "../types/env";

// Validation patterns
// Commit SHA: 7-40 hex characters (supports short and full SHAs)
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
// Repository: owner/repo format with allowed characters matching GitHub's rules
// Only alphanumeric, hyphens, underscores, and dots - prevents injection attacks
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const app = new Hono<{ Bindings: Env }>();

interface ProjectDoc {
  _id: string;
  organizationId: string;
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

interface RunDoc {
  _id: string;
  runId: string;
  workflowName?: string;
  conclusion?: string;
  runAttempt: number;
  errorCount?: number;
  commitSha?: string;
  headBranch?: string;
  runCompletedAt?: number;
  repository: string;
}

interface RunErrorDoc {
  _id: string;
  runId: string;
  filePath?: string;
  line?: number;
  column?: number;
  message: string;
  category?: string;
  severity?: string;
  source?: string;
  ruleId?: string;
  hints?: string[];
  stackTrace?: string;
  codeSnippet?: {
    lines: string[];
    startLine: number;
    errorLine: number;
    language: string;
  };
  workflowJob?: string;
  lineKnown?: boolean;
  unknownPattern?: boolean;
}

/**
 * GET /
 * Get errors for a commit
 *
 * Query params:
 * - commit: Commit SHA (required, can be short or full)
 * - repository: Repository in "owner/repo" format (required)
 */
app.get("/", async (c) => {
  const auth = c.get("auth");
  const commitParam = c.req.query("commit");
  const repository = c.req.query("repository");

  if (!commitParam) {
    return c.json({ error: "commit query parameter is required" }, 400);
  }

  if (!repository) {
    return c.json({ error: "repository query parameter is required" }, 400);
  }

  // Validate commit SHA format (7-40 hex characters)
  if (!COMMIT_SHA_PATTERN.test(commitParam)) {
    return c.json(
      { error: "Invalid commit SHA format (expected 7-40 hex characters)" },
      400
    );
  }

  // Validate repository format
  if (!REPOSITORY_PATTERN.test(repository)) {
    return c.json(
      { error: "Invalid repository format (expected 'owner/repo')" },
      400
    );
  }

  const convex = getConvexClient(c.env);
  const project = (await convex.query("projects:getByRepoFullName", {
    providerRepoFullName: repository,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Repository not found or not linked" }, 404);
  }

  const organization = (await convex.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Verify user has access to the organization
  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  const normalizedCommit = commitParam.toLowerCase();
  let commitRuns: RunDoc[] = [];
  let truncated = false;
  if (normalizedCommit.length === 40) {
    commitRuns = (await convex.query("runs:listByRepoCommit", {
      repository,
      commitSha: normalizedCommit,
    })) as RunDoc[];
  } else {
    const result = (await convex.query("runs:listByRepoCommitPrefix", {
      repository,
      commitPrefix: normalizedCommit,
      limit: 5000,
    })) as { runs: RunDoc[]; isTruncated: boolean };
    commitRuns = result.runs;
    truncated = result.isTruncated;
  }

  if (commitRuns.length === 0) {
    return c.json({ error: "No CI runs found for this commit" }, 404);
  }

  if (truncated) {
    return c.json(
      {
        error:
          "Commit SHA prefix matches too many runs. Please use a longer SHA prefix.",
      },
      400
    );
  }

  // Detect ambiguous short SHA matches (multiple distinct commits)
  const commitShas = commitRuns
    .map((r) => r.commitSha)
    .filter((value): value is string => Boolean(value));
  const distinctCommits = new Set(commitShas);
  if (distinctCommits.size > 1) {
    return c.json(
      {
        error: `Ambiguous commit SHA: '${normalizedCommit}' matches ${distinctCommits.size} different commits. Please use a longer SHA prefix.`,
      },
      400
    );
  }

  const fullCommitSha = commitShas[0] ?? normalizedCommit;

  const sortedRuns = [...commitRuns].sort(
    (a, b) => b.runAttempt - a.runAttempt
  );
  const latestRunsMap = new Map<string, RunDoc>();
  for (const run of sortedRuns) {
    if (run.runId && !latestRunsMap.has(run.runId)) {
      latestRunsMap.set(run.runId, run);
    }
  }
  const latestRuns = Array.from(latestRunsMap.values());

  const runIds = latestRuns.map((r) => r._id);
  const errorsByRun = await Promise.all(
    runIds.map((runId) =>
      convex.query("run-errors:listByRunId", { runId, limit: 1000 })
    )
  );
  const errors = errorsByRun.flat() as RunErrorDoc[];

  return c.json({
    commit: fullCommitSha,
    repository,
    runs: latestRuns.map((r) => ({
      id: r._id,
      runId: r.runId,
      workflowName: r.workflowName,
      conclusion: r.conclusion,
      runAttempt: r.runAttempt,
      errorCount: r.errorCount,
      headBranch: r.headBranch,
      completedAt: r.runCompletedAt
        ? new Date(r.runCompletedAt).toISOString()
        : null,
    })),
    // SECURITY: Scrub secrets from user-facing fields to prevent credential leakage
    // CI logs may contain API keys, tokens, or credentials in error messages/hints
    errors: errors.map((e) => ({
      id: e._id,
      filePath: e.filePath,
      line: e.line,
      column: e.column,
      message: scrubSecrets(e.message),
      category: e.category,
      severity: e.severity,
      source: e.source,
      ruleId: e.ruleId,
      hints: e.hints?.map(scrubSecrets),
      stackTrace: e.stackTrace ? scrubSecrets(e.stackTrace) : null,
      codeSnippet: e.codeSnippet,
      workflowJob: e.workflowJob,
      lineKnown: e.lineKnown,
      unknownPattern: e.unknownPattern,
    })),
  });
});

export default app;
