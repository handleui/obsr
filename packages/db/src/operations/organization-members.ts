import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { organizationMembers } from "../schema/index.js";
import { clampLimit } from "../utils.js";

export type OrganizationMemberRole = "owner" | "admin" | "member" | "visitor";

interface TimestampPatchInput {
  providerLinkedAt?: number | null;
  providerVerifiedAt?: number | null;
  removedAt?: number | null;
  updatedAt?: number | null;
}

interface CreateMemberInput {
  organizationId: string;
  userId: string;
  role: OrganizationMemberRole;
  providerUserId?: string | null;
  providerUsername?: string | null;
  providerLinkedAt?: number | null;
  providerVerifiedAt?: number | null;
  membershipSource?: string | null;
  removedAt?: number | null;
  removalReason?: string | null;
  removedBy?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

interface UpdateMemberInput {
  id: string;
  role?: OrganizationMemberRole;
  providerUserId?: string | null;
  providerUsername?: string | null;
  providerLinkedAt?: number | null;
  providerVerifiedAt?: number | null;
  membershipSource?: string | null;
  removedAt?: number | null;
  removalReason?: string | null;
  removedBy?: string | null;
  updatedAt?: number | null;
}

interface ListByOrgInput {
  organizationId: string;
  includeRemoved?: boolean | null;
  limit?: number | null;
}

interface PaginateByOrgInput extends ListByOrgInput {
  cursor?: string | null;
  numItems: number;
}

interface LeaveOrganizationInput {
  organizationId: string;
  userId: string;
  removedBy: string;
}

interface UpdateRoleInput {
  organizationId: string;
  targetUserId: string;
  actorRole: OrganizationMemberRole;
  newRole: OrganizationMemberRole;
}

interface RoleUpdateSuccess {
  success: true;
  user_id: string;
  old_role: OrganizationMemberRole;
  new_role: OrganizationMemberRole;
}

interface RoleUpdateError {
  error: string;
  status: number;
  message?: string;
}

type RoleUpdateResult = RoleUpdateSuccess | RoleUpdateError;

type LeaveOrganizationResult =
  | { success: true; message?: string }
  | { error: string; code?: string; status: number };
type TxLike = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

const toDate = (value: number | null | undefined): Date | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return new Date(value);
};

const withMemberLock = async (db: TxLike, lockKey: string) => {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
};

const isElevatedRole = (role: string): boolean =>
  role === "owner" || role === "admin";

const buildTimestampPatch = (input: TimestampPatchInput) => ({
  providerLinkedAt: toDate(input.providerLinkedAt),
  providerVerifiedAt: toDate(input.providerVerifiedAt),
  removedAt: toDate(input.removedAt),
  updatedAt: toDate(input.updatedAt) ?? new Date(),
});

export const create = async (db: Db, input: CreateMemberInput) => {
  const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
  const [row] = await db
    .insert(organizationMembers)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      providerUserId: input.providerUserId ?? null,
      providerUsername: input.providerUsername ?? null,
      providerLinkedAt: toDate(input.providerLinkedAt),
      providerVerifiedAt: toDate(input.providerVerifiedAt),
      membershipSource: input.membershipSource ?? null,
      removedAt: toDate(input.removedAt),
      removalReason: input.removalReason ?? null,
      removedBy: input.removedBy ?? null,
      createdAt,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : createdAt,
    })
    .returning({ id: organizationMembers.id });
  return row?.id ?? null;
};

export const createIfMissing = async (db: Db, input: CreateMemberInput) =>
  db.transaction(async (tx) => {
    const lockKey = `org_member:${input.organizationId}:${input.userId}`;
    await withMemberLock(tx, lockKey);

    const [existing] = await tx
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, input.organizationId),
          eq(organizationMembers.userId, input.userId)
        )
      )
      .orderBy(desc(organizationMembers.createdAt))
      .limit(1);

    if (existing) {
      return existing;
    }

    const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
    const [created] = await tx
      .insert(organizationMembers)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        role: input.role,
        providerUserId: input.providerUserId ?? null,
        providerUsername: input.providerUsername ?? null,
        providerLinkedAt: toDate(input.providerLinkedAt),
        providerVerifiedAt: toDate(input.providerVerifiedAt),
        membershipSource: input.membershipSource ?? null,
        createdAt,
        updatedAt: input.updatedAt ? new Date(input.updatedAt) : createdAt,
      })
      .returning();

    return created ?? null;
  });

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.id, id))
    .limit(1);
  return row ?? null;
};

export const getByOrgUser = async (
  db: TxLike,
  organizationId: string,
  userId: string
) => {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId)
      )
    )
    .orderBy(desc(organizationMembers.createdAt))
    .limit(1);
  return row ?? null;
};

export const getByOrgProviderUser = async (
  db: Db,
  organizationId: string,
  providerUserId: string
) => {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.providerUserId, providerUserId)
      )
    )
    .orderBy(desc(organizationMembers.createdAt))
    .limit(1);
  return row ?? null;
};

export const listByOrgProviderUser = (
  db: Db,
  organizationId: string,
  providerUserId: string
) =>
  db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.providerUserId, providerUserId)
      )
    )
    .orderBy(desc(organizationMembers.createdAt))
    .limit(10);

export const listByOrg = (db: Db, input: ListByOrgInput) => {
  const limit = clampLimit(input.limit, 1, 500, 200);
  return db
    .select()
    .from(organizationMembers)
    .where(
      input.includeRemoved
        ? eq(organizationMembers.organizationId, input.organizationId)
        : and(
            eq(organizationMembers.organizationId, input.organizationId),
            isNull(organizationMembers.removedAt)
          )
    )
    .orderBy(asc(organizationMembers.createdAt))
    .limit(limit);
};

export const paginateByOrg = async (db: Db, input: PaginateByOrgInput) => {
  const limit = clampLimit(input.numItems, 1, 500, 100);
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, input.organizationId),
        input.includeRemoved
          ? sql`true`
          : isNull(organizationMembers.removedAt),
        input.cursor
          ? sql`${organizationMembers.createdAt} > ${new Date(input.cursor)}`
          : sql`true`
      )
    )
    .orderBy(asc(organizationMembers.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    page,
    continueCursor:
      rows.length > limit ? (last?.createdAt.toISOString() ?? null) : null,
    isDone: rows.length <= limit,
  };
};

export const listByUser = (db: Db, userId: string, limit?: number | null) => {
  const take = clampLimit(limit, 1, 500, 200);
  return db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .orderBy(desc(organizationMembers.createdAt))
    .limit(take);
};

export const listByOrgRole = (
  db: Db,
  organizationId: string,
  role: OrganizationMemberRole
) =>
  db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.role, role)
      )
    )
    .limit(500);

export const listByProviderUserId = (db: Db, providerUserId: string) =>
  db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.providerUserId, providerUserId))
    .limit(50);

export const update = async (db: Db, input: UpdateMemberInput) => {
  const [row] = await db
    .update(organizationMembers)
    .set({
      role: input.role,
      providerUserId: input.providerUserId,
      providerUsername: input.providerUsername,
      membershipSource: input.membershipSource,
      removalReason: input.removalReason,
      removedBy: input.removedBy,
      ...buildTimestampPatch({
        providerLinkedAt: input.providerLinkedAt,
        providerVerifiedAt: input.providerVerifiedAt,
        removedAt: input.removedAt,
        updatedAt: input.updatedAt,
      }),
    })
    .where(eq(organizationMembers.id, input.id))
    .returning({ id: organizationMembers.id });

  return row?.id ?? null;
};

const countActiveMemberStats = async (
  db: TxLike,
  organizationId: string,
  trackElevated: boolean
): Promise<{ activeCount: number; elevatedCount: number }> => {
  const rows = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        isNull(organizationMembers.removedAt)
      )
    );

  let activeCount = 0;
  let elevatedCount = 0;
  for (const row of rows) {
    activeCount += 1;
    if (trackElevated && isElevatedRole(row.role)) {
      elevatedCount += 1;
    }
    if (activeCount > 1 && (!trackElevated || elevatedCount > 1)) {
      break;
    }
  }

  return { activeCount, elevatedCount };
};

export const leaveOrganization = async (
  db: Db,
  input: LeaveOrganizationInput
): Promise<LeaveOrganizationResult> =>
  db.transaction(async (tx) => {
    const lockKey = `org_leave:${input.organizationId}:${input.userId}`;
    await withMemberLock(tx, lockKey);

    const member = await getByOrgUser(tx, input.organizationId, input.userId);
    if (!member || member.removedAt) {
      return { success: true, message: "No membership record to remove" };
    }

    const needsElevated = isElevatedRole(member.role);
    const { activeCount, elevatedCount } = await countActiveMemberStats(
      tx,
      input.organizationId,
      needsElevated
    );

    if (activeCount === 1) {
      return {
        error:
          "Cannot leave as the only member. Use `dt org delete` to remove the organization.",
        code: "sole_member",
        status: 400,
      };
    }

    if (needsElevated && elevatedCount === 1) {
      return {
        error: `Cannot leave ${input.organizationId} as the only owner/admin. Transfer ownership first.`,
        status: 400,
      };
    }

    await tx
      .update(organizationMembers)
      .set({
        removedAt: new Date(),
        removalReason: "user_left",
        removedBy: input.removedBy,
        updatedAt: new Date(),
      })
      .where(eq(organizationMembers.id, member.id));

    return { success: true };
  });

const countActiveOwners = async (
  db: TxLike,
  organizationId: string
): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.role, "owner"),
        isNull(organizationMembers.removedAt)
      )
    );
  return row?.count ?? 0;
};

const countActiveElevatedMembers = async (
  db: TxLike,
  organizationId: string
): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        isNull(organizationMembers.removedAt),
        or(
          eq(organizationMembers.role, "owner"),
          eq(organizationMembers.role, "admin")
        )
      )
    );
  return row?.count ?? 0;
};

const getPermissionError = (
  actorRole: OrganizationMemberRole,
  oldRole: OrganizationMemberRole,
  newRole: OrganizationMemberRole
): RoleUpdateError | null => {
  if (actorRole !== "admin") {
    return null;
  }
  if (newRole === "owner") {
    return {
      error: "Insufficient permissions",
      message: "Only owners can promote members to owner",
      status: 403,
    };
  }
  if (oldRole === "owner") {
    return {
      error: "Insufficient permissions",
      message: "Only owners can modify other owners",
      status: 403,
    };
  }
  return null;
};

const getOwnerDemotionError = async (
  db: TxLike,
  organizationId: string,
  oldRole: OrganizationMemberRole,
  newRole: OrganizationMemberRole
): Promise<RoleUpdateError | null> => {
  if (!(oldRole === "owner" && newRole !== "owner")) {
    return null;
  }

  const activeOwners = await countActiveOwners(db, organizationId);
  if (activeOwners === 1) {
    return {
      error: "Cannot demote the last owner",
      message: "Transfer ownership to another member before demoting yourself",
      status: 400,
    };
  }

  return null;
};

const getAdminDemotionError = async (
  db: TxLike,
  organizationId: string,
  oldRole: OrganizationMemberRole,
  newRole: OrganizationMemberRole
): Promise<RoleUpdateError | null> => {
  if (
    !(oldRole === "admin" && (newRole === "member" || newRole === "visitor"))
  ) {
    return null;
  }

  const elevatedCount = await countActiveElevatedMembers(db, organizationId);
  if (elevatedCount === 1) {
    return {
      error: "Cannot demote the last admin",
      message: "Promote another member to admin first",
      status: 400,
    };
  }

  return null;
};

export const updateRole = async (
  db: Db,
  input: UpdateRoleInput
): Promise<RoleUpdateResult> =>
  db.transaction(async (tx) => {
    const lockKey = `org_role:${input.organizationId}:${input.targetUserId}`;
    await withMemberLock(tx, lockKey);

    const target = await getByOrgUser(
      tx,
      input.organizationId,
      input.targetUserId
    );

    if (!target || target.removedAt) {
      return { error: "Member not found", status: 404 };
    }

    const oldRole = target.role;
    if (oldRole === input.newRole) {
      return {
        success: true,
        user_id: input.targetUserId,
        old_role: oldRole,
        new_role: input.newRole,
      };
    }

    const permissionError = getPermissionError(
      input.actorRole,
      oldRole,
      input.newRole
    );
    if (permissionError) {
      return permissionError;
    }

    const ownerDemotionError = await getOwnerDemotionError(
      tx,
      input.organizationId,
      oldRole,
      input.newRole
    );
    if (ownerDemotionError) {
      return ownerDemotionError;
    }

    const adminDemotionError = await getAdminDemotionError(
      tx,
      input.organizationId,
      oldRole,
      input.newRole
    );
    if (adminDemotionError) {
      return adminDemotionError;
    }

    await tx
      .update(organizationMembers)
      .set({ role: input.newRole, updatedAt: new Date() })
      .where(
        and(
          eq(organizationMembers.id, target.id),
          ne(organizationMembers.role, input.newRole)
        )
      );

    return {
      success: true,
      user_id: input.targetUserId,
      old_role: oldRole,
      new_role: input.newRole,
    };
  });
