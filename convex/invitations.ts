import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  buildPatch,
  clampLimit,
  nullableNumber,
  nullableString,
} from "./validators";

const organizationRole = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("visitor")
);

const invitationStatus = v.union(
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("expired"),
  v.literal("revoked")
);

export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    email: v.string(),
    role: organizationRole,
    token: v.string(),
    status: invitationStatus,
    expiresAt: v.number(),
    invitedBy: v.string(),
    acceptedAt: v.optional(nullableNumber),
    acceptedByUserId: v.optional(nullableString),
    revokedAt: v.optional(nullableNumber),
    revokedBy: v.optional(nullableString),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("invitations", {
      organizationId: args.organizationId,
      email: args.email,
      role: args.role,
      token: args.token,
      status: args.status,
      expiresAt: args.expiresAt,
      invitedBy: args.invitedBy,
      acceptedAt: args.acceptedAt,
      acceptedByUserId: args.acceptedByUserId,
      revokedAt: args.revokedAt,
      revokedBy: args.revokedBy,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
  },
});

export const getById = query({
  args: { id: v.id("invitations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();
  },
});

export const listByOrgStatus = query({
  args: {
    organizationId: v.id("organizations"),
    status: invitationStatus,
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("invitations")
      .withIndex("by_org_status", (q) =>
        q.eq("organizationId", args.organizationId).eq("status", args.status)
      )
      .take(limit);
  },
});

export const listByEmail = query({
  args: { email: v.string(), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("invitations")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .take(limit);
  },
});

export const update = mutation({
  args: {
    id: v.id("invitations"),
    status: v.optional(invitationStatus),
    expiresAt: v.optional(v.number()),
    acceptedAt: v.optional(nullableNumber),
    acceptedByUserId: v.optional(nullableString),
    revokedAt: v.optional(nullableNumber),
    revokedBy: v.optional(nullableString),
    updatedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.id);

    if (!invitation) {
      return null;
    }

    await ctx.db.patch(
      invitation._id,
      buildPatch({
        status: args.status,
        expiresAt: args.expiresAt,
        acceptedAt: args.acceptedAt,
        acceptedByUserId: args.acceptedByUserId,
        revokedAt: args.revokedAt,
        revokedBy: args.revokedBy,
        updatedAt: args.updatedAt,
      })
    );

    return String(invitation._id);
  },
});

export const remove = mutation({
  args: { id: v.id("invitations") },
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.id);

    if (!invitation) {
      return null;
    }

    await ctx.db.delete(invitation._id);
    return String(invitation._id);
  },
});

export const accept = mutation({
  args: {
    token: v.string(),
    userId: v.string(),
    githubUserId: v.string(),
    githubUsername: v.string(),
  },
  handler: async (ctx, args) => {
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .first();

    if (!invitation) {
      return { error: "Invitation not found", status: 404 };
    }

    const now = Date.now();
    const isExpired =
      invitation.status === "expired" || invitation.expiresAt < now;

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
        await ctx.db.patch(invitation._id, {
          status: "expired",
          updatedAt: now,
        });
      }
      return { error: "This invitation has expired", status: 400 };
    }

    const member = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q
          .eq("organizationId", invitation.organizationId)
          .eq("userId", args.userId)
      )
      .first();

    if (member && !member.removedAt) {
      await ctx.db.patch(invitation._id, {
        status: "accepted",
        acceptedAt: now,
        acceptedByUserId: args.userId,
        updatedAt: now,
      });

      return {
        error: "You are already a member of this organization",
        status: 409,
      };
    }

    if (member?.removedAt) {
      await ctx.db.patch(member._id, {
        removedAt: undefined,
        removalReason: undefined,
        removedBy: undefined,
        role: invitation.role,
        providerUserId: args.githubUserId,
        providerUsername: args.githubUsername,
        providerLinkedAt: now,
        membershipSource: "manual_invite",
        updatedAt: now,
      });
    } else if (!member) {
      await ctx.db.insert("organizationMembers", {
        organizationId: invitation.organizationId,
        userId: args.userId,
        role: invitation.role,
        providerUserId: args.githubUserId,
        providerUsername: args.githubUsername,
        providerLinkedAt: now,
        membershipSource: "manual_invite",
        createdAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.patch(invitation._id, {
      status: "accepted",
      acceptedAt: now,
      acceptedByUserId: args.userId,
      updatedAt: now,
    });

    return {
      success: true,
      organizationId: invitation.organizationId,
      role: invitation.role,
    };
  },
});
