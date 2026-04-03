import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import { vercelConnections, vercelSyncTargets } from "./schema";

export interface UpsertVercelConnectionInput {
  ownerUserId: string;
  encryptedAccessToken: string;
  targets: Array<{
    teamId: string;
    teamSlug?: string;
    projectId: string;
    projectName?: string;
    repo?: string;
  }>;
}

export const upsertVercelConnection = (input: UpsertVercelConnectionInput) => {
  const { db } = getDb();
  const keepKeys = input.targets.map(
    (target) => `${target.teamId}:${target.projectId}`
  );

  return db.transaction(async (tx) => {
    await tx
      .insert(vercelConnections)
      .values({
        ownerUserId: input.ownerUserId,
        encryptedAccessToken: input.encryptedAccessToken,
      })
      .onConflictDoUpdate({
        target: vercelConnections.ownerUserId,
        set: {
          encryptedAccessToken: input.encryptedAccessToken,
          updatedAt: new Date(),
        },
      });

    for (const target of input.targets) {
      await tx
        .insert(vercelSyncTargets)
        .values({
          ownerUserId: input.ownerUserId,
          teamId: target.teamId,
          teamSlug: target.teamSlug ?? null,
          projectId: target.projectId,
          projectName: target.projectName ?? null,
          repo: target.repo ?? null,
        })
        .onConflictDoUpdate({
          target: [
            vercelSyncTargets.ownerUserId,
            vercelSyncTargets.teamId,
            vercelSyncTargets.projectId,
          ],
          set: {
            teamSlug: target.teamSlug ?? null,
            projectName: target.projectName ?? null,
            repo: target.repo ?? null,
            updatedAt: new Date(),
          },
        });
    }

    if (keepKeys.length > 0) {
      const existingTargets = await tx
        .select({
          id: vercelSyncTargets.id,
          teamId: vercelSyncTargets.teamId,
          projectId: vercelSyncTargets.projectId,
        })
        .from(vercelSyncTargets)
        .where(eq(vercelSyncTargets.ownerUserId, input.ownerUserId));

      const staleTargetIds = existingTargets
        .filter(
          (target) => !keepKeys.includes(`${target.teamId}:${target.projectId}`)
        )
        .map((target) => target.id);

      if (staleTargetIds.length > 0) {
        await tx
          .delete(vercelSyncTargets)
          .where(
            and(
              eq(vercelSyncTargets.ownerUserId, input.ownerUserId),
              inArray(vercelSyncTargets.id, staleTargetIds)
            )
          );
      }
    }
  });
};

export const getVercelConnection = async (ownerUserId: string) => {
  const { db } = getDb();
  const [connection] = await db
    .select({
      id: vercelConnections.id,
      ownerUserId: vercelConnections.ownerUserId,
      encryptedAccessToken: vercelConnections.encryptedAccessToken,
      createdAt: vercelConnections.createdAt,
      updatedAt: vercelConnections.updatedAt,
    })
    .from(vercelConnections)
    .where(eq(vercelConnections.ownerUserId, ownerUserId))
    .limit(1);

  return connection ?? null;
};

export const listVercelSyncTargets = (ownerUserId: string) => {
  const { db } = getDb();
  return db
    .select({
      id: vercelSyncTargets.id,
      ownerUserId: vercelSyncTargets.ownerUserId,
      teamId: vercelSyncTargets.teamId,
      teamSlug: vercelSyncTargets.teamSlug,
      projectId: vercelSyncTargets.projectId,
      projectName: vercelSyncTargets.projectName,
      repo: vercelSyncTargets.repo,
      lastSyncedAt: vercelSyncTargets.lastSyncedAt,
      lastDeploymentCreatedAt: vercelSyncTargets.lastDeploymentCreatedAt,
      createdAt: vercelSyncTargets.createdAt,
      updatedAt: vercelSyncTargets.updatedAt,
    })
    .from(vercelSyncTargets)
    .where(eq(vercelSyncTargets.ownerUserId, ownerUserId));
};

export const listOwnedVercelSyncTargetsByIds = (
  ownerUserId: string,
  targetIds: string[]
) => {
  if (targetIds.length === 0) {
    return Promise.resolve([]);
  }

  const { db } = getDb();
  return db
    .select({
      id: vercelSyncTargets.id,
      ownerUserId: vercelSyncTargets.ownerUserId,
      teamId: vercelSyncTargets.teamId,
      teamSlug: vercelSyncTargets.teamSlug,
      projectId: vercelSyncTargets.projectId,
      projectName: vercelSyncTargets.projectName,
      repo: vercelSyncTargets.repo,
      lastSyncedAt: vercelSyncTargets.lastSyncedAt,
      lastDeploymentCreatedAt: vercelSyncTargets.lastDeploymentCreatedAt,
      createdAt: vercelSyncTargets.createdAt,
      updatedAt: vercelSyncTargets.updatedAt,
    })
    .from(vercelSyncTargets)
    .where(
      and(
        eq(vercelSyncTargets.ownerUserId, ownerUserId),
        inArray(vercelSyncTargets.id, targetIds)
      )
    );
};

export const updateVercelSyncTargetCursor = async ({
  id,
  ownerUserId,
  lastDeploymentCreatedAt,
  lastSyncedAt,
}: {
  id: string;
  ownerUserId: string;
  lastDeploymentCreatedAt: Date | null;
  lastSyncedAt: Date;
}) => {
  const { db } = getDb();
  await db
    .update(vercelSyncTargets)
    .set({
      lastDeploymentCreatedAt,
      lastSyncedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(vercelSyncTargets.id, id),
        eq(vercelSyncTargets.ownerUserId, ownerUserId)
      )
    );
};
