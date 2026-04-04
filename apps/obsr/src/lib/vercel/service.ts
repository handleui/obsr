import { findIssueIdByObservationDedupeKey } from "@/db/queries";
import {
  getVercelConnection,
  listOwnedVercelSyncTargetsByIds,
  listVercelSyncTargets,
  updateVercelSyncTargetCursor,
  upsertVercelConnection,
} from "@/db/vercel-queries";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { RouteError } from "@/lib/http";
import type { IssueIngestInput } from "@/lib/issues/schema";
import { VercelApiClient } from "./client";
import {
  normalizeBuildObservation,
  normalizeRuntimeObservations,
  shouldFetchBuildLogs,
  shouldFetchRuntimeLogs,
} from "./normalize";
import type {
  VercelConnectionInput,
  VercelSyncRequest,
  VercelTarget,
} from "./schema";
import {
  VercelConnectionResponseSchema,
  VercelSyncResponseSchema,
} from "./schema";

const DEFAULT_DEPLOYMENT_LOOKBACK_MS = 1000 * 60 * 60 * 24 * 7;

type IngestIssueFn = (
  input: IssueIngestInput,
  ownerUserId: string
) => Promise<{ id: string }>;

const serializeDate = (value: Date | null) => {
  return value ? value.toISOString() : null;
};

const toTarget = (target: {
  id: string;
  teamId: string;
  teamSlug: string | null;
  projectId: string;
  projectName: string | null;
  repo: string | null;
  lastSyncedAt: Date | null;
  lastDeploymentCreatedAt: Date | null;
}): VercelTarget => {
  return {
    id: target.id,
    teamId: target.teamId,
    teamSlug: target.teamSlug,
    projectId: target.projectId,
    projectName: target.projectName,
    repo: target.repo,
    lastSyncedAt: serializeDate(target.lastSyncedAt),
    lastDeploymentCreatedAt: serializeDate(target.lastDeploymentCreatedAt),
  };
};

const getDeploymentSince = (lastDeploymentCreatedAt: Date | null) => {
  return (
    lastDeploymentCreatedAt?.getTime() ??
    Date.now() - DEFAULT_DEPLOYMENT_LOOKBACK_MS
  );
};

const getRuntimeSince = (lastSyncedAt: Date | null) => {
  return lastSyncedAt?.getTime();
};

const createApiClient = async (ownerUserId: string) => {
  const connection = await getVercelConnection(ownerUserId);
  if (!connection) {
    throw new RouteError(
      404,
      "VERCEL_NOT_CONNECTED",
      "Configure a Vercel connection before syncing."
    );
  }

  try {
    return new VercelApiClient({
      accessToken: decryptSecret(connection.encryptedAccessToken),
    });
  } catch {
    throw new RouteError(
      500,
      "VERCEL_CONNECTION_INVALID",
      "The saved Vercel connection is invalid or could not be loaded."
    );
  }
};

const loadIngestIssue = async (): Promise<IngestIssueFn> => {
  const issueService = await import("@/lib/issues/service");
  return issueService.ingestIssue;
};

const listSelectedTargets = (ownerUserId: string, targetIds?: string[]) => {
  if (targetIds?.length) {
    return listOwnedVercelSyncTargetsByIds(ownerUserId, targetIds);
  }

  return listVercelSyncTargets(ownerUserId);
};

const ingestObservationIfNew = async ({
  ingestIssueFn,
  observation,
  ownerUserId,
}: {
  ingestIssueFn: IngestIssueFn;
  observation: IssueIngestInput | null;
  ownerUserId: string;
}) => {
  if (!observation?.dedupeKey) {
    return {
      issueId: null,
      wasCreated: false,
    };
  }

  const existingIssueId = await findIssueIdByObservationDedupeKey(
    ownerUserId,
    observation.dedupeKey
  );

  if (existingIssueId) {
    return {
      issueId: existingIssueId,
      wasCreated: false,
    };
  }

  const issue = await ingestIssueFn(observation, ownerUserId);
  return {
    issueId: issue.id,
    wasCreated: true,
  };
};

const trackDeploymentCreatedAt = (
  latestDeploymentCreatedAt: Date | null,
  deploymentCreatedAt: Date | null
) => {
  if (
    deploymentCreatedAt &&
    (!latestDeploymentCreatedAt ||
      deploymentCreatedAt > latestDeploymentCreatedAt)
  ) {
    return deploymentCreatedAt;
  }

  return latestDeploymentCreatedAt;
};

const syncBuildObservation = async ({
  client,
  deployment,
  deploymentId,
  ingestIssueFn,
  ownerUserId,
  target,
}: {
  client: VercelApiClient;
  deployment: Awaited<ReturnType<VercelApiClient["listDeployments"]>>[number];
  deploymentId: string;
  ingestIssueFn: IngestIssueFn;
  ownerUserId: string;
  target: Awaited<ReturnType<typeof listVercelSyncTargets>>[number];
}) => {
  if (!shouldFetchBuildLogs(deployment)) {
    return {
      issueId: null,
      wasCreated: false,
    };
  }

  const observation = normalizeBuildObservation({
    deployment,
    events: await client.listDeploymentEvents({
      deploymentId,
      teamId: target.teamId,
    }),
    target,
  });

  if (!observation) {
    return {
      issueId: null,
      wasCreated: false,
    };
  }

  return ingestObservationIfNew({
    ingestIssueFn,
    observation,
    ownerUserId,
  });
};

const syncRuntimeObservations = async ({
  client,
  deployment,
  deploymentId,
  ingestIssueFn,
  ownerUserId,
  target,
}: {
  client: VercelApiClient;
  deployment: Awaited<ReturnType<VercelApiClient["listDeployments"]>>[number];
  deploymentId: string;
  ingestIssueFn: IngestIssueFn;
  ownerUserId: string;
  target: Awaited<ReturnType<typeof listVercelSyncTargets>>[number];
}) => {
  if (!shouldFetchRuntimeLogs(deployment)) {
    return [];
  }

  const observations = normalizeRuntimeObservations({
    deployment,
    logs: await client.listRuntimeLogs({
      deploymentId,
      projectId: target.projectId,
      since: getRuntimeSince(target.lastSyncedAt),
      teamId: target.teamId,
    }),
    target,
  });

  return Promise.all(
    observations.map((observation) =>
      ingestObservationIfNew({
        ingestIssueFn,
        observation,
        ownerUserId,
      })
    )
  );
};

const validateConnectionTargets = async (input: VercelConnectionInput) => {
  const client = new VercelApiClient({
    accessToken: input.accessToken,
  });

  try {
    await Promise.all(
      input.targets.map((target) =>
        client.listDeployments({
          projectId: target.projectId,
          teamId: target.teamId,
        })
      )
    );
  } catch {
    throw new RouteError(
      400,
      "VERCEL_CONNECTION_INVALID",
      "The Vercel token could not access one or more configured targets."
    );
  }
};

const syncTarget = async ({
  client,
  ingestIssueFn,
  ownerUserId,
  target,
}: {
  client: VercelApiClient;
  ingestIssueFn: IngestIssueFn;
  ownerUserId: string;
  target: Awaited<ReturnType<typeof listVercelSyncTargets>>[number];
}) => {
  const deployments = await client.listDeployments({
    projectId: target.projectId,
    since: getDeploymentSince(target.lastDeploymentCreatedAt),
    teamId: target.teamId,
  });
  const issueIds = new Set<string>();
  let observationsCreated = 0;
  let observationsSkipped = 0;
  let latestDeploymentCreatedAt = target.lastDeploymentCreatedAt;

  for (const deployment of deployments) {
    const deploymentId = deployment.uid ?? deployment.id;
    const deploymentCreatedAt = deployment.createdAt
      ? new Date(deployment.createdAt)
      : null;
    latestDeploymentCreatedAt = trackDeploymentCreatedAt(
      latestDeploymentCreatedAt,
      deploymentCreatedAt
    );

    if (!deploymentId) {
      continue;
    }

    const buildResult = await syncBuildObservation({
      client,
      deployment,
      deploymentId,
      ingestIssueFn,
      ownerUserId,
      target,
    });

    if (buildResult.issueId) {
      issueIds.add(buildResult.issueId);
      if (buildResult.wasCreated) {
        observationsCreated += 1;
      } else {
        observationsSkipped += 1;
      }
    }

    const runtimeResults = await syncRuntimeObservations({
      client,
      deployment,
      deploymentId,
      ingestIssueFn,
      ownerUserId,
      target,
    });

    for (const result of runtimeResults) {
      if (!result.issueId) {
        continue;
      }

      issueIds.add(result.issueId);
      if (result.wasCreated) {
        observationsCreated += 1;
      } else {
        observationsSkipped += 1;
      }
    }
  }

  await updateVercelSyncTargetCursor({
    id: target.id,
    ownerUserId,
    lastDeploymentCreatedAt: latestDeploymentCreatedAt,
    lastSyncedAt: new Date(),
  });

  return {
    deploymentsSeen: deployments.length,
    issueIds,
    observationsCreated,
    observationsSkipped,
  };
};

export const saveVercelConnection = async (
  ownerUserId: string,
  input: VercelConnectionInput
) => {
  await validateConnectionTargets(input);

  await upsertVercelConnection({
    ownerUserId,
    encryptedAccessToken: encryptSecret(input.accessToken),
    targets: input.targets,
  });

  return VercelConnectionResponseSchema.parse({
    configured: true,
    targets: (await listVercelSyncTargets(ownerUserId)).map(toTarget),
  });
};

export const getVercelTargets = async (ownerUserId: string) => {
  return (await listVercelSyncTargets(ownerUserId)).map(toTarget);
};

export const syncVercelTargets = async (
  ownerUserId: string,
  input: VercelSyncRequest,
  options?: {
    ingestIssueFn?: IngestIssueFn;
  }
) => {
  const client = await createApiClient(ownerUserId);
  const targets = await listSelectedTargets(ownerUserId, input.targetIds);
  const ingestIssueFn = options?.ingestIssueFn ?? (await loadIngestIssue());

  if (targets.length === 0) {
    throw new RouteError(
      404,
      "VERCEL_TARGETS_NOT_FOUND",
      "No Vercel sync targets were found for this account."
    );
  }

  const issueIds = new Set<string>();
  let deploymentsSeen = 0;
  let observationsCreated = 0;
  let observationsSkipped = 0;

  for (const target of targets) {
    const result = await syncTarget({
      client,
      ingestIssueFn,
      ownerUserId,
      target,
    });
    deploymentsSeen += result.deploymentsSeen;
    observationsCreated += result.observationsCreated;
    observationsSkipped += result.observationsSkipped;

    for (const issueId of result.issueIds) {
      issueIds.add(issueId);
    }
  }

  return VercelSyncResponseSchema.parse({
    targetsSynced: targets.length,
    deploymentsSeen,
    observationsCreated,
    observationsSkipped,
    issueIds: [...issueIds],
  });
};
