/**
 * Errors API routes
 *
 * Provides access to CI errors for a commit, used by the CLI `detent errors` command.
 */

import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { projects, runErrors, runs } from "../db/schema";
import { verifyOrgAccess } from "../lib/org-access";
import type { Env } from "../types/env";

// Validation patterns
// Commit SHA: 7-40 hex characters (supports short and full SHAs)
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
// Repository: owner/repo format with allowed characters matching GitHub's rules
// Only alphanumeric, hyphens, underscores, and dots - prevents injection attacks
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const app = new Hono<{ Bindings: Env }>();

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

  const { db, client } = await createDb(c.env);
  try {
    // Look up project to verify access
    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.providerRepoFullName, repository),
        isNull(projects.removedAt)
      ),
      with: { organization: true },
    });

    if (!project) {
      return c.json({ error: "Repository not found or not linked" }, 404);
    }

    // Verify user has access to the organization
    const access = await verifyOrgAccess(
      auth.userId,
      project.organization,
      c.env
    );
    if (!access.allowed) {
      return c.json({ error: access.error }, 403);
    }

    // Build commit SHA condition (support both short and full SHAs)
    // Input is validated above to contain only hex characters, safe for LIKE pattern
    const normalizedCommit = commitParam.toLowerCase();
    const commitCondition =
      normalizedCommit.length === 40
        ? eq(runs.commitSha, normalizedCommit)
        : like(runs.commitSha, `${normalizedCommit}%`);

    // Find all runs for this commit in this repository
    // Get the latest attempt for each runId
    const commitRuns = await db
      .select({
        id: runs.id,
        runId: runs.runId,
        workflowName: runs.workflowName,
        conclusion: runs.conclusion,
        runAttempt: runs.runAttempt,
        errorCount: runs.errorCount,
        commitSha: runs.commitSha,
        headBranch: runs.headBranch,
        runCompletedAt: runs.runCompletedAt,
      })
      .from(runs)
      .where(and(eq(runs.repository, repository), commitCondition))
      .orderBy(desc(runs.runAttempt));

    const firstRun = commitRuns[0];
    if (!firstRun) {
      return c.json({ error: "No CI runs found for this commit" }, 404);
    }

    // Get the full commit SHA from the first run
    const fullCommitSha = firstRun.commitSha;

    // Keep only the latest attempt for each runId
    const latestRunsMap = new Map<string, (typeof commitRuns)[0]>();
    for (const run of commitRuns) {
      if (run.runId && !latestRunsMap.has(run.runId)) {
        latestRunsMap.set(run.runId, run);
      }
    }
    const latestRuns = Array.from(latestRunsMap.values());

    // Get all errors for these runs (uses run_errors_run_id_idx index)
    const runIds = latestRuns.map((r) => r.id);
    const errors =
      runIds.length > 0
        ? await db
            .select({
              id: runErrors.id,
              runId: runErrors.runId,
              filePath: runErrors.filePath,
              line: runErrors.line,
              column: runErrors.column,
              message: runErrors.message,
              category: runErrors.category,
              severity: runErrors.severity,
              source: runErrors.source,
              ruleId: runErrors.ruleId,
              hint: runErrors.hint,
              workflowJob: runErrors.workflowJob,
            })
            .from(runErrors)
            .where(inArray(runErrors.runId, runIds))
        : [];

    return c.json({
      commit: fullCommitSha,
      repository,
      runs: latestRuns.map((r) => ({
        id: r.id,
        runId: r.runId,
        workflowName: r.workflowName,
        conclusion: r.conclusion,
        runAttempt: r.runAttempt,
        errorCount: r.errorCount,
        headBranch: r.headBranch,
        completedAt: r.runCompletedAt?.toISOString() ?? null,
      })),
      errors: errors.map((e) => ({
        id: e.id,
        filePath: e.filePath,
        line: e.line,
        column: e.column,
        message: e.message,
        category: e.category,
        severity: e.severity,
        source: e.source,
        ruleId: e.ruleId,
        hint: e.hint,
        workflowJob: e.workflowJob,
      })),
    });
  } finally {
    await client.end();
  }
});

export default app;
