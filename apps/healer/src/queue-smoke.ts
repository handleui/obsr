import { type Db, runErrorOps, runOps } from "@detent/db";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { createDbClient } from "./services/db-client.js";

const securedFunctions = new Set([
  "api_keys:create",
  "api_keys:getById",
  "api_keys:getByKeyHash",
  "api_keys:listByOrg",
  "api_keys:updateLastUsedAt",
  "api_keys:update",
  "api_keys:remove",
  "heals:create",
  "heals:get",
  "heals:getByPr",
  "heals:getByProjectStatus",
  "heals:getActiveByProject",
  "heals:getByRunId",
  "heals:getPending",
  "heals:updateStatus",
  "heals:apply",
  "heals:reject",
  "heals:trigger",
  "heals:setCheckRunId",
  "heals:markStaleAsFailed",
  "organizations:create",
  "organizations:getById",
  "organizations:getBySlug",
  "organizations:getByProviderAccount",
  "organizations:getByProviderAccountLogin",
  "organizations:listByProviderAccountIds",
  "organizations:listByInstallerGithubId",
  "organizations:listByEnterprise",
  "organizations:listByProviderInstallationId",
  "organizations:list",
  "organizations:listActiveGithub",
  "organizations:update",
  "projects:create",
  "projects:getById",
  "projects:listByOrg",
  "projects:countByOrg",
  "projects:getByOrgHandle",
  "projects:getByOrgRepo",
  "projects:getByRepoFullName",
  "projects:getByRepoId",
  "projects:listByRepoIds",
  "projects:update",
  "projects:reactivate",
  "projects:syncFromGitHub",
  "projects:clearRemovedByOrg",
  "projects:softDeleteByRepoIds",
]);

const withServiceToken = (
  args: Record<string, unknown> | undefined,
  serviceToken: string
): Record<string, unknown> => ({
  ...(args ?? {}),
  serviceToken,
});

type ConvexMethod = (
  name: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

const wrapWithServiceToken =
  (baseFn: ConvexMethod, serviceToken: string): ConvexMethod =>
  (name: string, args?: Record<string, unknown>) => {
    if (!securedFunctions.has(name)) {
      return baseFn(name, args);
    }
    return baseFn(
      name,
      withServiceToken(
        args as Record<string, unknown> | undefined,
        serviceToken
      )
    );
  };

const createConvexClient = (
  url: string,
  serviceToken: string
): ConvexHttpClient => {
  const client = new ConvexHttpClient(url);

  client.query = wrapWithServiceToken(
    client.query.bind(client) as unknown as ConvexMethod,
    serviceToken
  ) as unknown as ConvexHttpClient["query"];

  client.mutation = wrapWithServiceToken(
    client.mutation.bind(client) as unknown as ConvexMethod,
    serviceToken
  ) as unknown as ConvexHttpClient["mutation"];

  return client;
};

interface RunRow {
  id: string;
  projectId: string | null;
  commitSha: string | null;
  prNumber: number | null;
  receivedAt: number | null;
}

interface RunErrorRow {
  id: string;
  signatureId: string | null;
  fixable: boolean;
}

const asQuery = (name: string) => name as unknown as FunctionReference<"query">;

const asMutation = (name: string) =>
  name as unknown as FunctionReference<"mutation">;

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

const fetchRunById = async (db: Db, runId: string): Promise<RunRow | null> => {
  const run = await runOps.getById(db, runId);
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    projectId: run.projectId ?? null,
    commitSha: run.commitSha ?? null,
    prNumber: run.prNumber ?? null,
    receivedAt: run.receivedAt ?? null,
  };
};

const fetchLatestFixableRun = async (
  db: Db,
  projectId?: string,
  prNumber?: number
): Promise<RunRow | null> => {
  let rows: Awaited<ReturnType<typeof runOps.listByProject>> = [];
  if (projectId) {
    rows = await runOps.listByProject(db, projectId, 200);
  } else if (prNumber) {
    rows = await runOps.listByPrNumber(db, prNumber, 200);
  }

  const sorted = rows
    .map((run) => ({
      id: run.id,
      projectId: run.projectId ?? null,
      commitSha: run.commitSha ?? null,
      prNumber: run.prNumber ?? null,
      receivedAt: run.receivedAt ?? null,
    }))
    .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0));

  for (const run of sorted) {
    if (!run.id) {
      continue;
    }
    const errors = await fetchRunErrors(db, run.id);
    if (errors.some((error) => error.fixable)) {
      return run;
    }
  }

  return null;
};

const fetchRunErrors = async (
  db: Db,
  runId: string
): Promise<RunErrorRow[]> => {
  const rows = await runErrorOps.listByRunId(db, runId, 1000);

  return rows.map((row) => ({
    id: row.id,
    signatureId: row.signatureId ?? null,
    fixable: row.fixable === true,
  }));
};

const ensureProjectExists = async (
  convex: ConvexHttpClient,
  projectId: string
): Promise<void> => {
  const result = (await convex.query(asQuery("projects:getById"), {
    id: projectId,
  })) as Record<string, unknown> | null;
  if (!result) {
    throw new Error(`Project ${projectId} not found`);
  }
};

interface SmokeEnv {
  convexUrl: string;
  serviceToken: string;
  databaseUrl: string;
  runId: string | undefined;
  projectId: string | undefined;
  prNumber: number | undefined;
}

const loadSmokeEnv = (): SmokeEnv => {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is required");
  }
  const serviceToken = process.env.CONVEX_SERVICE_TOKEN;
  if (!serviceToken) {
    throw new Error("CONVEX_SERVICE_TOKEN is required");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const runId = process.env.RUN_ID;
  const projectId = process.env.PROJECT_ID;
  const prNumber = parseNumber(process.env.PR_NUMBER, "PR_NUMBER");

  if (!(runId || projectId || prNumber)) {
    throw new Error("RUN_ID, PROJECT_ID, or PR_NUMBER is required");
  }

  return { convexUrl, serviceToken, databaseUrl, runId, projectId, prNumber };
};

interface ValidatedRun extends RunRow {
  projectId: string;
}

const resolveFixableRun = async (
  db: Db,
  smokeEnv: SmokeEnv
): Promise<{ run: ValidatedRun; fixableErrors: RunErrorRow[] }> => {
  const run = smokeEnv.runId
    ? await fetchRunById(db, smokeEnv.runId)
    : await fetchLatestFixableRun(db, smokeEnv.projectId, smokeEnv.prNumber);

  if (!run?.projectId) {
    throw new Error("No run found with fixable errors");
  }

  const runErrors = await fetchRunErrors(db, run.id);
  const fixableErrors = runErrors.filter((error) => error.fixable);
  if (fixableErrors.length === 0) {
    throw new Error("Run has no fixable errors");
  }

  return { run: run as ValidatedRun, fixableErrors };
};

const main = async (): Promise<void> => {
  const smokeEnv = loadSmokeEnv();
  const convex = createConvexClient(smokeEnv.convexUrl, smokeEnv.serviceToken);
  const { db, pool } = createDbClient(smokeEnv.databaseUrl);

  try {
    const { run, fixableErrors } = await resolveFixableRun(db, smokeEnv);

    await ensureProjectExists(convex, run.projectId);

    const errorIds = fixableErrors.map((err) => err.id);
    const signatureIds = fixableErrors
      .map((err) => err.signatureId)
      .filter((id): id is string => id !== null);

    const healId = await convex.mutation(asMutation("heals:create"), {
      type: "heal",
      status: "pending",
      projectId: run.projectId,
      runId: run.id,
      commitSha: run.commitSha ?? undefined,
      prNumber: run.prNumber ?? undefined,
      errorIds,
      signatureIds,
    });

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
