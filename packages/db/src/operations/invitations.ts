import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Db } from "../client.js";
import { invitations, organizationMembers } from "../schema/index.js";
import { clampLimit } from "../utils.js";

export type InvitationRole = "owner" | "admin" | "member" | "visitor";
export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

interface CreateInvitationInput {
  organizationId: string;
  email: string;
  role: InvitationRole;
  token: string;
  status: InvitationStatus;
  expiresAt: number;
  invitedBy: string;
  acceptedAt?: number | null;
  acceptedByUserId?: string | null;
  revokedAt?: number | null;
  revokedBy?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

interface UpdateInvitationInput {
  id: string;
  status?: InvitationStatus;
  expiresAt?: number;
  acceptedAt?: number | null;
  acceptedByUserId?: string | null;
  revokedAt?: number | null;
  revokedBy?: string | null;
  updatedAt?: number;
}

interface AcceptInvitationInput {
  token: string;
  userId: string;
  githubUserId: string;
  githubUsername: string;
}

interface AcceptInvitationError {
  error: string;
  status: number;
}

interface AcceptInvitationSuccess {
  success: true;
  organizationId: string;
  role: InvitationRole;
}

type AcceptInvitationResult =
  | AcceptInvitationError
  | (AcceptInvitationError & { organizationId?: string; role?: InvitationRole })
  | AcceptInvitationSuccess;

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

const withInvitationLock = async (db: TxLike, token: string) => {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`invitation:${token}`}))`
  );
};

export const create = async (db: Db, input: CreateInvitationInput) =>
  db.transaction(async (tx) => {
    await withInvitationLock(tx, input.token);

    const [existing] = await tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(eq(invitations.token, input.token))
      .limit(1);

    if (existing) {
      return existing.id;
    }

    const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
    const [row] = await tx
      .insert(invitations)
      .values({
        organizationId: input.organizationId,
        email: input.email,
        role: input.role,
        token: input.token,
        status: input.status,
        expiresAt: new Date(input.expiresAt),
        invitedBy: input.invitedBy,
        acceptedAt: toDate(input.acceptedAt),
        acceptedByUserId: input.acceptedByUserId ?? null,
        revokedAt: toDate(input.revokedAt),
        revokedBy: input.revokedBy ?? null,
        createdAt,
        updatedAt: input.updatedAt ? new Date(input.updatedAt) : createdAt,
      })
      .returning({ id: invitations.id });

    return row?.id ?? null;
  });

export const getById = async (db: Db, id: string) => {
  const [row] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.id, id))
    .limit(1);
  return row ?? null;
};

export const getByToken = async (db: Db, token: string) => {
  const [row] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1);
  return row ?? null;
};

export const listByOrgStatus = (
  db: Db,
  organizationId: string,
  status: InvitationStatus,
  limit?: number | null
) => {
  const take = clampLimit(limit, 1, 500, 200);
  return db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, organizationId),
        eq(invitations.status, status)
      )
    )
    .orderBy(desc(invitations.createdAt))
    .limit(take);
};

export const listByEmail = (db: Db, email: string, limit?: number | null) => {
  const take = clampLimit(limit, 1, 500, 200);
  return db
    .select()
    .from(invitations)
    .where(eq(invitations.email, email))
    .orderBy(desc(invitations.createdAt))
    .limit(take);
};

export const update = async (db: Db, input: UpdateInvitationInput) => {
  const [row] = await db
    .update(invitations)
    .set({
      status: input.status,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
      acceptedAt: toDate(input.acceptedAt),
      acceptedByUserId: input.acceptedByUserId,
      revokedAt: toDate(input.revokedAt),
      revokedBy: input.revokedBy,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : new Date(),
    })
    .where(eq(invitations.id, input.id))
    .returning({ id: invitations.id });

  return row?.id ?? null;
};

export const remove = async (db: Db, id: string) => {
  const [row] = await db
    .delete(invitations)
    .where(eq(invitations.id, id))
    .returning({ id: invitations.id });
  return row?.id ?? null;
};

export const accept = async (
  db: Db,
  input: AcceptInvitationInput
): Promise<AcceptInvitationResult> =>
  db.transaction(async (tx) => {
    await withInvitationLock(tx, input.token);

    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.token, input.token))
      .limit(1);

    if (!invitation) {
      return { error: "Invitation not found", status: 404 };
    }

    const now = new Date();
    const isExpired =
      invitation.status === "expired" ||
      invitation.expiresAt.getTime() < now.getTime();

    if (invitation.status === "accepted") {
      return {
        error: "This invitation has already been accepted",
        status: 400,
      };
    }

    if (invitation.status === "revoked") {
      return { error: "This invitation has been revoked", status: 400 };
    }

    if (isExpired) {
      if (invitation.status !== "expired") {
        await tx
          .update(invitations)
          .set({ status: "expired", updatedAt: now })
          .where(eq(invitations.id, invitation.id));
      }
      return { error: "This invitation has expired", status: 400 };
    }

    const [member] = await tx
      .select()
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, invitation.organizationId),
          eq(organizationMembers.userId, input.userId)
        )
      )
      .orderBy(asc(organizationMembers.createdAt))
      .limit(1);

    if (member && !member.removedAt) {
      await tx
        .update(invitations)
        .set({
          status: "accepted",
          acceptedAt: now,
          acceptedByUserId: input.userId,
          updatedAt: now,
        })
        .where(eq(invitations.id, invitation.id));

      return {
        error: "You are already a member of this organization",
        status: 409,
        organizationId: invitation.organizationId,
        role: invitation.role,
      };
    }

    if (member?.removedAt) {
      await tx
        .update(organizationMembers)
        .set({
          removedAt: null,
          removalReason: null,
          removedBy: null,
          role: invitation.role,
          providerUserId: input.githubUserId,
          providerUsername: input.githubUsername,
          providerLinkedAt: now,
          membershipSource: "manual_invite",
          updatedAt: now,
        })
        .where(eq(organizationMembers.id, member.id));
    } else if (!member) {
      await tx.insert(organizationMembers).values({
        organizationId: invitation.organizationId,
        userId: input.userId,
        role: invitation.role,
        providerUserId: input.githubUserId,
        providerUsername: input.githubUsername,
        providerLinkedAt: now,
        membershipSource: "manual_invite",
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .update(invitations)
      .set({
        status: "accepted",
        acceptedAt: now,
        acceptedByUserId: input.userId,
        updatedAt: now,
      })
      .where(eq(invitations.id, invitation.id));

    return {
      success: true,
      organizationId: invitation.organizationId,
      role: invitation.role,
    };
  });
