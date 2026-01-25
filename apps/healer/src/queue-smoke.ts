import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

interface RunRow {
  id: string;
  project_id: string | null;
  commit_sha: string | null;
  pr_number: number | null;
}

interface RunErrorRow {
  id: string;
  signature_id: string | null;
}

const parseNumber = (
  value: string | undefined,
  name: string
): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
};

const fetchRunById = async (
  db: ReturnType<typeof drizzle>,
  runId: string
): Promise<RunRow | null> => {
  const result = await db.execute(sql`
    SELECT id, project_id, commit_sha, pr_number
    FROM runs
    WHERE id = ${runId}
    LIMIT 1
  `);
  return (result.rows[0] as RunRow | undefined) ?? null;
};

const fetchLatestFixableRun = async (
  db: ReturnType<typeof drizzle>,
  projectId?: string,
  prNumber?: number
): Promise<RunRow | null> => {
  const conditions: SQL[] = [sql`e.fixable = true`];
  if (projectId) {
    conditions.push(sql`r.project_id = ${projectId}`);
  }
  if (prNumber) {
    conditions.push(sql`r.pr_number = ${prNumber}`);
  }

  const result = await db.execute(sql`
    SELECT r.id, r.project_id, r.commit_sha, r.pr_number
    FROM runs r
    JOIN run_errors e ON e.run_id = r.id
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY r.received_at DESC
    LIMIT 1
  `);

  return (result.rows[0] as RunRow | undefined) ?? null;
};

const fetchRunErrors = async (
  db: ReturnType<typeof drizzle>,
  runId: string
): Promise<RunErrorRow[]> => {
  const result = await db.execute(sql`
    SELECT id, signature_id
    FROM run_errors
    WHERE run_id = ${runId} AND fixable = true
    ORDER BY id
  `);
  return result.rows as unknown as RunErrorRow[];
};

const ensureProjectExists = async (
  db: ReturnType<typeof drizzle>,
  projectId: string
): Promise<void> => {
  const result = await db.execute(sql`
    SELECT id
    FROM projects
    WHERE id = ${projectId}
    LIMIT 1
  `);
  if (!result.rows[0]) {
    throw new Error(`Project ${projectId} not found`);
  }
};

const main = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const runId = process.env.RUN_ID;
  const projectId = process.env.PROJECT_ID;
  const prNumber = parseNumber(process.env.PR_NUMBER, "PR_NUMBER");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  try {
    const run = runId
      ? await fetchRunById(db, runId)
      : await fetchLatestFixableRun(db, projectId, prNumber);

    if (!run?.project_id) {
      throw new Error("No run found with fixable errors");
    }

    await ensureProjectExists(db, run.project_id);

    const runErrors = await fetchRunErrors(db, run.id);
    if (runErrors.length === 0) {
      throw new Error("Run has no fixable errors");
    }

    const errorIds = runErrors.map((err) => err.id);
    const signatureIds = runErrors
      .map((err) => err.signature_id)
      .filter((id): id is string => id !== null);

    const healId = crypto.randomUUID();
    const errorIdsJson = JSON.stringify(errorIds);
    const signatureIdsJson = signatureIds.length
      ? JSON.stringify(signatureIds)
      : null;

    await db.execute(sql`
      INSERT INTO heals (
        id,
        type,
        status,
        project_id,
        run_id,
        commit_sha,
        pr_number,
        error_ids,
        signature_ids,
        created_at,
        updated_at
      )
      VALUES (
        ${healId},
        'heal',
        'pending',
        ${run.project_id},
        ${run.id},
        ${run.commit_sha},
        ${run.pr_number},
        ${errorIdsJson}::jsonb,
        ${signatureIdsJson}::jsonb,
        NOW(),
        NOW()
      )
    `);

    console.log(`Queued heal ${healId} for run ${run.id}`);
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[queue-smoke] ${message}`);
  process.exit(1);
});
