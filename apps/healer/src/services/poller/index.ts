import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Env } from "../../env.js";
import { env } from "../../env.js";
import { getInstallationToken } from "../github/token.js";
import { executeHeal } from "../heal-executor.js";

const POLL_INTERVAL_MS = 5000;
const MAX_CONCURRENT_HEALS = 5;
const POOL_SIZE = 5;

interface HealRow {
  id: string;
  type: string;
  status: string;
  run_id: string | null;
  project_id: string;
  commit_sha: string | null;
  pr_number: number | null;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  provider_repo_full_name: string;
  provider_default_branch: string | null;
}

interface RunRow {
  id: string;
  commit_sha: string | null;
  head_branch: string | null;
}

interface RunErrorRow {
  id: string;
  message: string;
  file_path: string | null;
  line: number | null;
  column: number | null;
  category: string | null;
  severity: string | null;
  rule_id: string | null;
  source: string | null;
  stack_trace: string | null;
}

interface OrganizationRow {
  provider_installation_id: string | null;
}

type Database = NodePgDatabase<Record<string, never>>;

interface PollerState {
  isRunning: boolean;
  activeHeals: number;
  dbPool: Pool | null;
}

const state: PollerState = {
  isRunning: false,
  activeHeals: 0,
  dbPool: null,
};

const createDatabase = (): Database => {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: POOL_SIZE,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error(`[poller] Database pool error: ${err.message}`);
  });

  state.dbPool = pool;
  return drizzle(pool);
};

const fetchPendingHeals = async (db: Database): Promise<HealRow[]> => {
  const limit = MAX_CONCURRENT_HEALS - state.activeHeals;
  if (limit <= 0) {
    return [];
  }

  const result = await db.execute(sql`
    SELECT id, type, status, run_id, project_id, commit_sha, pr_number
    FROM heals
    WHERE type = 'heal' AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `);

  return result.rows as unknown as HealRow[];
};

const markHealRunning = async (db: Database, healId: string): Promise<void> => {
  await db.execute(sql`
    UPDATE heals
    SET status = 'running', updated_at = NOW()
    WHERE id = ${healId}
  `);
};

const markHealCompleted = async (
  db: Database,
  healId: string,
  data: {
    patch: string | null;
    filesChanged: string[];
    result: {
      iterations: number;
      costUSD: number;
      inputTokens: number;
      outputTokens: number;
      finalMessage: string;
    };
  }
): Promise<void> => {
  const healResult = {
    model: "claude-sonnet-4-20250514",
    patchApplied: false,
    verificationPassed: data.patch !== null,
    toolCalls: 0,
  };

  const costUsdCents = Math.round(data.result.costUSD * 100);

  await db.execute(sql`
    UPDATE heals
    SET
      status = 'completed',
      patch = ${data.patch},
      files_changed = ${JSON.stringify(data.filesChanged)}::jsonb,
      heal_result = ${JSON.stringify(healResult)}::jsonb,
      cost_usd = ${costUsdCents},
      input_tokens = ${data.result.inputTokens},
      output_tokens = ${data.result.outputTokens},
      updated_at = NOW()
    WHERE id = ${healId}
  `);
};

const markHealFailed = async (
  db: Database,
  healId: string,
  reason: string
): Promise<void> => {
  const truncatedReason =
    reason.length > 2000 ? `${reason.slice(0, 1997)}...` : reason;

  await db.execute(sql`
    UPDATE heals
    SET status = 'failed', failed_reason = ${truncatedReason}, updated_at = NOW()
    WHERE id = ${healId}
  `);
};

const fetchProject = async (
  db: Database,
  projectId: string
): Promise<ProjectRow | null> => {
  const result = await db.execute(sql`
    SELECT id, organization_id, provider_repo_full_name, provider_default_branch
    FROM projects
    WHERE id = ${projectId}
    LIMIT 1
  `);

  return (result.rows[0] as unknown as ProjectRow | undefined) ?? null;
};

const fetchRun = async (
  db: Database,
  runId: string
): Promise<RunRow | null> => {
  const result = await db.execute(sql`
    SELECT id, commit_sha, head_branch
    FROM runs
    WHERE id = ${runId}
    LIMIT 1
  `);

  return (result.rows[0] as unknown as RunRow | undefined) ?? null;
};

const fetchRunErrors = async (
  db: Database,
  runId: string
): Promise<RunErrorRow[]> => {
  const result = await db.execute(sql`
    SELECT id, message, file_path, line, "column", category, severity, rule_id, source, stack_trace
    FROM run_errors
    WHERE run_id = ${runId}
    ORDER BY id
  `);

  return result.rows as unknown as RunErrorRow[];
};

const fetchOrganization = async (
  db: Database,
  orgId: string
): Promise<OrganizationRow | null> => {
  const result = await db.execute(sql`
    SELECT provider_installation_id
    FROM organizations
    WHERE id = ${orgId}
    LIMIT 1
  `);

  return (result.rows[0] as unknown as OrganizationRow | undefined) ?? null;
};

const maskSecret = (secret: string): string =>
  secret.length > 8 ? `${secret.slice(0, 4)}****` : "****";

const buildRepoUrl = (
  repoFullName: string,
  token: string | null
): { url: string; masked: string } => {
  if (token) {
    return {
      url: `https://x-access-token:${token}@github.com/${repoFullName}.git`,
      masked: `https://x-access-token:${maskSecret(token)}@github.com/${repoFullName}.git`,
    };
  }
  const publicUrl = `https://github.com/${repoFullName}.git`;
  return { url: publicUrl, masked: publicUrl };
};

const formatErrorsForPrompt = (errors: RunErrorRow[]): string => {
  if (errors.length === 0) {
    return "(no errors found)";
  }

  const formatted = errors.map((err) => {
    const location = err.file_path
      ? `${err.file_path}:${err.line ?? "-"}:${err.column ?? "-"}`
      : `line ${err.line ?? "-"}:${err.column ?? "-"}`;

    let line = `[${err.category ?? "unknown"}] ${location}: ${err.message}`;

    if (err.rule_id || err.source) {
      line += `\n  Rule: ${err.rule_id ?? "-"} | Source: ${err.source ?? "-"}`;
    }

    if (err.stack_trace) {
      const stackLines = err.stack_trace.split("\n").slice(0, 10);
      line += `\n  Stack trace:\n    ${stackLines.join("\n    ")}`;
    }

    return line;
  });

  return formatted.join("\n\n");
};

const processHeal = async (
  db: Database,
  heal: HealRow,
  appEnv: Env
): Promise<void> => {
  console.log(`[poller] Processing heal ${heal.id}`);

  try {
    await markHealRunning(db, heal.id);

    const project = await fetchProject(db, heal.project_id);
    if (!project) {
      throw new Error(`Project ${heal.project_id} not found`);
    }

    const org = await fetchOrganization(db, project.organization_id);

    let branch = project.provider_default_branch ?? "main";
    let errors: RunErrorRow[] = [];

    if (heal.run_id) {
      const [run, runErrors] = await Promise.all([
        fetchRun(db, heal.run_id),
        fetchRunErrors(db, heal.run_id),
      ]);
      if (run) {
        branch = run.head_branch ?? branch;
      }
      errors = runErrors;
    }

    let token: string | null = null;
    if (org?.provider_installation_id) {
      const installationId = Number.parseInt(org.provider_installation_id, 10);
      if (!Number.isNaN(installationId)) {
        token = await getInstallationToken(appEnv, installationId);
      }
    }

    const { url: repoUrl, masked: maskedRepoUrl } = buildRepoUrl(
      project.provider_repo_full_name,
      token
    );

    console.log(`[poller] Cloning ${maskedRepoUrl} branch ${branch}`);

    const userPrompt = `Fix the following CI errors:\n\n${formatErrorsForPrompt(errors)}`;

    const result = await executeHeal(appEnv, {
      healId: heal.id,
      repoUrl,
      branch,
      userPrompt,
      budgetPerRunUSD: 1.0,
      remainingMonthlyUSD: -1,
    });

    if (result.success) {
      await markHealCompleted(db, heal.id, {
        patch: result.patch,
        filesChanged: result.filesChanged,
        result: result.result,
      });
      console.log(`[poller] Heal ${heal.id} completed successfully`);
    } else {
      await markHealFailed(db, heal.id, result.error ?? "Heal failed");
      console.log(`[poller] Heal ${heal.id} failed: ${result.error}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[poller] Error processing heal ${heal.id}: ${message}`);
    await markHealFailed(db, heal.id, message);
  }
};

const pollLoop = async (db: Database, appEnv: Env): Promise<void> => {
  while (state.isRunning) {
    try {
      const pendingHeals = await fetchPendingHeals(db);

      for (const heal of pendingHeals) {
        if (!state.isRunning) {
          break;
        }

        state.activeHeals++;

        processHeal(db, heal, appEnv)
          .finally(() => {
            state.activeHeals--;
          })
          .catch((err) => {
            console.error(
              `[poller] Unhandled error in processHeal: ${err instanceof Error ? err.message : String(err)}`
            );
          });
      }
    } catch (error) {
      console.error(
        `[poller] Poll loop error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
};

const markStaleHealsAsFailed = async (db: Database): Promise<void> => {
  try {
    const result = await db.execute(sql`
      UPDATE heals
      SET
        status = 'failed',
        failed_reason = 'Heal timed out',
        updated_at = NOW()
      WHERE
        type = 'heal'
        AND status IN ('pending', 'running')
        AND updated_at < NOW() - INTERVAL '30 minutes'
      RETURNING id
    `);

    if (result.rowCount && result.rowCount > 0) {
      console.log(`[poller] Marked ${result.rowCount} stale heals as failed`);
    }
  } catch (error) {
    console.error(
      `[poller] Error marking stale heals: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const startPoller = async (): Promise<void> => {
  if (state.isRunning) {
    console.warn("[poller] Already running");
    return;
  }

  console.log("[poller] Starting...");

  try {
    const db = createDatabase();
    state.isRunning = true;

    await markStaleHealsAsFailed(db);

    pollLoop(db, env).catch((err) => {
      console.error(
        `[poller] Fatal error: ${err instanceof Error ? err.message : String(err)}`
      );
      state.isRunning = false;
    });

    console.log("[poller] Started successfully");
  } catch (error) {
    console.error(
      `[poller] Failed to start: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
};

export const stopPoller = async (): Promise<void> => {
  if (!state.isRunning) {
    return;
  }

  console.log("[poller] Stopping...");
  state.isRunning = false;

  while (state.activeHeals > 0) {
    console.log(
      `[poller] Waiting for ${state.activeHeals} active heals to complete`
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (state.dbPool) {
    await state.dbPool.end();
    state.dbPool = null;
  }

  console.log("[poller] Stopped");
};
