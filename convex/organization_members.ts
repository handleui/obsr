import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { requireServiceAuth } from "./service_auth";
import {
  buildPatch,
  clampLimit,
  nullableBoolean,
  nullableNumber,
  nullableString,
} from "./validators";

const organizationRole = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("visitor")
);
const serviceToken = v.optional(v.string());

export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    userId: v.string(),
    role: organizationRole,
    providerUserId: v.optional(nullableString),
    providerUsername: v.optional(nullableString),
    providerLinkedAt: v.optional(nullableNumber),
    providerVerifiedAt: v.optional(nullableNumber),
    membershipSource: v.optional(nullableString),
    removedAt: v.optional(nullableNumber),
    removalReason: v.optional(nullableString),
    removedBy: v.optional(nullableString),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("organizationMembers", {
      organizationId: args.organizationId,
      userId: args.userId,
      role: args.role,
      providerUserId: args.providerUserId,
      providerUsername: args.providerUsername,
      providerLinkedAt: args.providerLinkedAt,
      providerVerifiedAt: args.providerVerifiedAt,
      membershipSource: args.membershipSource,
      removedAt: args.removedAt,
      removalReason: args.removalReason,
      removedBy: args.removedBy,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
  },
});

export const createIfMissing = mutation({
  args: {
    organizationId: v.id("organizations"),
    userId: v.string(),
    role: organizationRole,
    providerUserId: v.optional(nullableString),
    providerUsername: v.optional(nullableString),
    providerLinkedAt: v.optional(nullableNumber),
    providerVerifiedAt: v.optional(nullableNumber),
    membershipSource: v.optional(nullableString),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", args.userId)
      )
      .first();

    if (existing) {
      return existing;
    }

    const now = Date.now();
    const docId = await ctx.db.insert("organizationMembers", {
      organizationId: args.organizationId,
      userId: args.userId,
      role: args.role,
      providerUserId: args.providerUserId,
      providerUsername: args.providerUsername,
      providerLinkedAt: args.providerLinkedAt,
      providerVerifiedAt: args.providerVerifiedAt,
      membershipSource: args.membershipSource,
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.get(docId);
  },
});

export const getById = query({
  args: { id: v.id("organizationMembers") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getByOrgUser = query({
  args: {
    organizationId: v.id("organizations"),
    userId: v.string(),
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    return await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", args.userId)
      )
      .first();
  },
});

export const getByOrgProviderUser = query({
  args: { organizationId: v.id("organizations"), providerUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_provider_user", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("providerUserId", args.providerUserId)
      )
      .first();
  },
});

export const listByOrgProviderUser = query({
  args: { organizationId: v.id("organizations"), providerUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_provider_user", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("providerUserId", args.providerUserId)
      )
      .collect();
  },
});

export const listByOrg = query({
  args: {
    organizationId: v.id("organizations"),
    includeRemoved: v.optional(nullableBoolean),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    const results: Record<string, unknown>[] = [];
    const query = ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", args.organizationId)
      );

    for await (const member of query) {
      if (!args.includeRemoved && member.removedAt) {
        continue;
      }
      results.push(member);
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  },
});

export const listByOrgAll = query({
  args: {
    organizationId: v.id("organizations"),
    includeRemoved: v.optional(nullableBoolean),
    limit: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 5000, 1000);
    const results: Record<string, unknown>[] = [];
    const query = ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", args.organizationId)
      );

    for await (const member of query) {
      if (!args.includeRemoved && member.removedAt) {
        continue;
      }
      results.push(member);
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  },
});

export const paginateByOrg = query({
  args: {
    organizationId: v.id("organizations"),
    includeRemoved: v.optional(nullableBoolean),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", args.organizationId)
      )
      .paginate(args.paginationOpts);

    if (args.includeRemoved) {
      return result;
    }

    return {
      ...result,
      page: result.page.filter((member) => !member.removedAt),
    };
  },
});

export const listByUser = query({
  args: { userId: v.string(), limit: v.optional(nullableNumber) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 1, 500, 200);
    return await ctx.db
      .query("organizationMembers")
      .withIndex("by_user_id", (q) => q.eq("userId", args.userId))
      .take(limit);
  },
});

export const listByOrgRole = query({
  args: { organizationId: v.id("organizations"), role: organizationRole },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_role", (q) =>
        q.eq("organizationId", args.organizationId).eq("role", args.role)
      )
      .collect();
  },
});

export const listByProviderUserId = query({
  args: { providerUserId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("organizationMembers")
      .withIndex("by_provider_user_id", (q) =>
        q.eq("providerUserId", args.providerUserId)
      )
      .collect();
  },
});

export const update = mutation({
  args: {
    id: v.id("organizationMembers"),
    role: v.optional(organizationRole),
    providerUserId: v.optional(nullableString),
    providerUsername: v.optional(nullableString),
    providerLinkedAt: v.optional(nullableNumber),
    providerVerifiedAt: v.optional(nullableNumber),
    membershipSource: v.optional(nullableString),
    removedAt: v.optional(nullableNumber),
    removalReason: v.optional(nullableString),
    removedBy: v.optional(nullableString),
    updatedAt: v.optional(nullableNumber),
  },
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.id);

    if (!member) {
      return null;
    }

    await ctx.db.patch(
      member._id,
      buildPatch({
        role: args.role,
        providerUserId: args.providerUserId,
        providerUsername: args.providerUsername,
        providerLinkedAt: args.providerLinkedAt,
        providerVerifiedAt: args.providerVerifiedAt,
        membershipSource: args.membershipSource,
        removedAt: args.removedAt,
        removalReason: args.removalReason,
        removedBy: args.removedBy,
        updatedAt: args.updatedAt,
      })
    );

    return String(member._id);
  },
});

export const leaveOrganization = mutation({
  args: {
    organizationId: v.id("organizations"),
    userId: v.string(),
    removedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const member = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", args.organizationId).eq("userId", args.userId)
      )
      .first();

    if (!member || member.removedAt) {
      return { success: true, message: "No membership record to remove" };
    }

    const needsElevated = member.role === "owner" || member.role === "admin";
    let activeCount = 0;
    let elevatedCount = 0;
    const members = ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", args.organizationId)
      );

    for await (const entry of members) {
      if (entry.removedAt) {
        continue;
      }
      activeCount += 1;
      if (needsElevated && (entry.role === "owner" || entry.role === "admin")) {
        elevatedCount += 1;
      }
      if (activeCount > 1 && (!needsElevated || elevatedCount > 1)) {
        break;
      }
    }

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
        error: `Cannot leave ${args.organizationId} as the only owner/admin. Transfer ownership first.`,
        status: 400,
      };
    }

    await ctx.db.patch(member._id, {
      removedAt: Date.now(),
      removalReason: "user_left",
      removedBy: args.removedBy,
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

interface RoleUpdateError {
  error: string;
  status: number;
  message?: string;
}

const countActiveOwners = async (
  ctx: MutationCtx,
  organizationId: Id<"organizations">
): Promise<number> => {
  let activeOwners = 0;
  const owners = ctx.db
    .query("organizationMembers")
    .withIndex("by_org_role", (q) =>
      q.eq("organizationId", organizationId).eq("role", "owner")
    );
  for await (const owner of owners) {
    if (owner.removedAt) {
      continue;
    }
    activeOwners += 1;
    if (activeOwners > 1) {
      break;
    }
  }
  return activeOwners;
};

const countActiveElevatedMembers = async (
  ctx: MutationCtx,
  organizationId: Id<"organizations">
): Promise<number> => {
  let elevatedCount = 0;
  const members = ctx.db
    .query("organizationMembers")
    .withIndex("by_org_user", (q) => q.eq("organizationId", organizationId));
  for await (const member of members) {
    if (member.removedAt) {
      continue;
    }
    if (member.role === "owner" || member.role === "admin") {
      elevatedCount += 1;
      if (elevatedCount > 1) {
        break;
      }
    }
  }
  return elevatedCount;
};

const getPermissionError = (
  actorRole: string,
  oldRole: string,
  newRole: string
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
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  oldRole: string,
  newRole: string
): Promise<RoleUpdateError | null> => {
  if (!(oldRole === "owner" && newRole !== "owner")) {
    return null;
  }

  const activeOwners = await countActiveOwners(ctx, organizationId);
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
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  oldRole: string,
  newRole: string
): Promise<RoleUpdateError | null> => {
  if (
    !(oldRole === "admin" && (newRole === "member" || newRole === "visitor"))
  ) {
    return null;
  }

  const elevatedCount = await countActiveElevatedMembers(ctx, organizationId);
  if (elevatedCount === 1) {
    return {
      error: "Cannot demote the last admin",
      message: "Promote another member to admin first",
      status: 400,
    };
  }

  return null;
};

export const updateRole = mutation({
  args: {
    organizationId: v.id("organizations"),
    targetUserId: v.string(),
    actorRole: organizationRole,
    newRole: organizationRole,
    serviceToken,
  },
  handler: async (ctx, args) => {
    await requireServiceAuth(ctx, args);
    const target = await ctx.db
      .query("organizationMembers")
      .withIndex("by_org_user", (q) =>
        q
          .eq("organizationId", args.organizationId)
          .eq("userId", args.targetUserId)
      )
      .first();

    if (!target || target.removedAt) {
      return { error: "Member not found", status: 404 };
    }

    const oldRole = target.role;
    if (oldRole === args.newRole) {
      return {
        success: true,
        user_id: args.targetUserId,
        old_role: oldRole,
        new_role: args.newRole,
      };
    }

    const permissionError = getPermissionError(
      args.actorRole,
      oldRole,
      args.newRole
    );
    if (permissionError) {
      return permissionError;
    }

    const ownerDemotionError = await getOwnerDemotionError(
      ctx,
      args.organizationId,
      oldRole,
      args.newRole
    );
    if (ownerDemotionError) {
      return ownerDemotionError;
    }

    const adminDemotionError = await getAdminDemotionError(
      ctx,
      args.organizationId,
      oldRole,
      args.newRole
    );
    if (adminDemotionError) {
      return adminDemotionError;
    }

    await ctx.db.patch(target._id, {
      role: args.newRole,
      updatedAt: Date.now(),
    });

    return {
      success: true,
      user_id: args.targetUserId,
      old_role: oldRole,
      new_role: args.newRole,
    };
  },
});
