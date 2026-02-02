import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

const securedFunctions = new Set([
  "api_keys:create",
  "api_keys:getById",
  "api_keys:getByKeyHash",
  "api_keys:listByOrg",
  "api_keys:updateLastUsedAt",
  "api_keys:update",
  "api_keys:remove",
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

const createConvexClient = (
  url: string,
  serviceToken: string
): ConvexHttpClient => {
  const client = new ConvexHttpClient(url);
  const baseQuery = client.query.bind(client) as unknown as (
    name: string,
    args?: Record<string, unknown>
  ) => Promise<unknown>;
  client.query = ((name: string, args?: Record<string, unknown>) => {
    if (!securedFunctions.has(name)) {
      return baseQuery(name, args);
    }
    return baseQuery(
      name,
      withServiceToken(
        args as Record<string, unknown> | undefined,
        serviceToken
      )
    );
  }) as unknown as ConvexHttpClient["query"];

  const baseMutation = client.mutation.bind(client) as unknown as (
    name: string,
    args?: Record<string, unknown>
  ) => Promise<unknown>;
  client.mutation = ((name: string, args?: Record<string, unknown>) => {
    if (!securedFunctions.has(name)) {
      return baseMutation(name, args);
    }
    return baseMutation(
      name,
      withServiceToken(
        args as Record<string, unknown> | undefined,
        serviceToken
      )
    );
  }) as unknown as ConvexHttpClient["mutation"];

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

const normalizeRun = (run: Record<string, unknown>): RunRow => {
  return {
    id: typeof run._id === "string" ? run._id : String(run.id ?? ""),
    projectId: typeof run.projectId === "string" ? run.projectId : null,
    commitSha: typeof run.commitSha === "string" ? run.commitSha : null,
    prNumber: typeof run.prNumber === "number" ? run.prNumber : null,
    receivedAt: typeof run.receivedAt === "number" ? run.receivedAt : null,
  };
};

const fetchRunById = async (
  convex: ConvexHttpClient,
  runId: string
): Promise<RunRow | null> => {
  const result = (await convex.query(asQuery("runs:getById"), {
    id: runId,
  })) as Record<string, unknown> | null;
  if (!result) {
    return null;
  }
  return normalizeRun(result);
};

const fetchLatestFixableRun = async (
  convex: ConvexHttpClient,
  projectId?: string,
  prNumber?: number
): Promise<RunRow | null> => {
  let runs: Record<string, unknown>[] = [];
  if (projectId) {
    runs = (await convex.query(asQuery("runs:listByProject"), {
      projectId,
      limit: 200,
    })) as Record<string, unknown>[];
  } else if (prNumber) {
    runs = (await convex.query(asQuery("runs:listByPrNumber"), {
      prNumber,
      limit: 200,
    })) as Record<string, unknown>[];
  }

  const sorted = runs
    .map(normalizeRun)
    .sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0));

  for (const run of sorted) {
    if (!run.id) {
      continue;
    }
    const errors = await fetchRunErrors(convex, run.id);
    if (errors.some((error) => error.fixable)) {
      return run;
    }
  }

  return null;
};

const fetchRunErrors = async (
  convex: ConvexHttpClient,
  runId: string
): Promise<RunErrorRow[]> => {
  const result = (await convex.query(asQuery("run_errors:listByRunId"), {
    runId,
    limit: 1000,
  })) as Record<string, unknown>[];

  return result.map((error) => ({
    id: typeof error._id === "string" ? error._id : String(error.id ?? ""),
    signatureId:
      typeof error.signatureId === "string" ? error.signatureId : null,
    fixable: error.fixable === true,
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

const main = async (): Promise<void> => {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is required");
  }
  const serviceToken = process.env.CONVEX_SERVICE_TOKEN;
  if (!serviceToken) {
    throw new Error("CONVEX_SERVICE_TOKEN is required");
  }

  const runId = process.env.RUN_ID;
  const projectId = process.env.PROJECT_ID;
  const prNumber = parseNumber(process.env.PR_NUMBER, "PR_NUMBER");

  // TODO: Add Convex query to find latest fixable run when no identifiers provided.
  if (!(runId || projectId || prNumber)) {
    throw new Error("RUN_ID, PROJECT_ID, or PR_NUMBER is required");
  }

  const convex = createConvexClient(convexUrl, serviceToken);

  const run = runId
    ? await fetchRunById(convex, runId)
    : await fetchLatestFixableRun(convex, projectId, prNumber);

  if (!run?.projectId) {
    throw new Error("No run found with fixable errors");
  }

  await ensureProjectExists(convex, run.projectId);

  const runErrors = await fetchRunErrors(convex, run.id);
  const fixableErrors = runErrors.filter((error) => error.fixable);
  if (fixableErrors.length === 0) {
    throw new Error("Run has no fixable errors");
  }

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
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[queue-smoke] ${message}`);
  process.exit(1);
});
