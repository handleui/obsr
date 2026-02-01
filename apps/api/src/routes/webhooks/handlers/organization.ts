import { getConvexClient } from "../../../db/convex";
import { cacheKey, deleteFromCache } from "../../../lib/cache";
import { captureWebhookError } from "../../../lib/sentry";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type { Env } from "../../../types/env";
import type { OrganizationPayload } from "../types";

interface MemberSyncResult {
  status: string;
  memberDemoted?: boolean;
  memberAdded?: boolean;
}

interface OrganizationDoc {
  _id: string;
}

interface OrganizationMemberDoc {
  _id: string;
  userId: string;
  role: "owner" | "admin" | "member" | "visitor";
  providerUserId?: string | null;
  providerUsername?: string | null;
  membershipSource?: string | null;
  removedAt?: number | null;
  removalReason?: string | null;
}

/**
 * Attempt to demote a member to visitor role when they're removed from GitHub.
 * Only demotes auto-joined members (not manually invited).
 * Security: Owners are never automatically demoted.
 */
const tryDemoteToVisitor = async (
  env: Env,
  githubOrgId: number,
  githubUserId: string,
  githubUsername: string,
  orgLogin: string,
  deliveryId: string
): Promise<MemberSyncResult> => {
  const convex = getConvexClient(env);
  try {
    // Find the organization by GitHub org ID
    const org = (await convex.query("organizations:getByProviderAccount", {
      provider: "github",
      providerAccountId: String(githubOrgId),
    })) as OrganizationDoc | null;

    if (!org) {
      console.log(
        `[webhook/organization] Org not found for GitHub org ID ${githubOrgId} [delivery: ${deliveryId}]`
      );
      return { status: "cache_invalidated", memberDemoted: false };
    }

    // Demote member to visitor role
    // Only demote auto-joined members, not manually invited
    // Security: Exclude owners (should not be auto-demoted) and visitors (no change needed)
    const members = (await convex.query(
      "organization-members:listByOrgProviderUser",
      {
        organizationId: org._id,
        providerUserId: githubUserId,
      }
    )) as OrganizationMemberDoc[];

    let memberDemoted = false;
    for (const member of members) {
      if (member.removedAt) {
        continue;
      }
      if (
        member.membershipSource !== "github_sync" &&
        member.membershipSource !== "github_webhook" &&
        member.membershipSource !== "github_access"
      ) {
        continue;
      }
      if (member.role !== "member" && member.role !== "admin") {
        continue;
      }

      await convex.mutation("organization-members:update", {
        id: member._id,
        role: "visitor",
        updatedAt: Date.now(),
      });
      memberDemoted = true;
    }

    if (memberDemoted) {
      console.log(
        `[webhook/organization] Demoted to visitor: ${githubUsername} (GitHub ID: ${githubUserId}) in ${orgLogin} [delivery: ${deliveryId}]`
      );
      return { status: "member_demoted", memberDemoted: true };
    }

    console.log(
      `[webhook/organization] Member ${githubUsername} not found in Detent for ${orgLogin} (or is owner/visitor) [delivery: ${deliveryId}]`
    );
    return { status: "cache_invalidated", memberDemoted: false };
  } catch (error) {
    console.error(
      `[webhook/organization] DB error demoting member in ${orgLogin} [delivery: ${deliveryId}]:`,
      error
    );
    // Structured error reporting for monitoring
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "organization",
      deliveryId,
    });
    // Don't fail the webhook - cache was still invalidated
    return { status: "cache_invalidated", memberDemoted: false };
  }
};

/**
 * Attempt to auto-add a member to Detent when they're added to GitHub org.
 * Only adds if user already exists in Detent system (has providerUserId in another org).
 */
const tryAutoAddMember = async (
  env: Env,
  githubOrgId: number,
  githubUserId: string,
  githubUsername: string,
  orgLogin: string,
  deliveryId: string
): Promise<MemberSyncResult> => {
  const convex = getConvexClient(env);
  try {
    // Find the organization by GitHub org ID
    const org = (await convex.query("organizations:getByProviderAccount", {
      provider: "github",
      providerAccountId: String(githubOrgId),
    })) as OrganizationDoc | null;

    if (!org) {
      console.log(
        `[webhook/organization] Org not found for GitHub org ID ${githubOrgId} [delivery: ${deliveryId}]`
      );
      return { status: "cache_invalidated", memberAdded: false };
    }

    // Single query to check all membership states for this user in this org
    // Replaces 3 separate queries with one
    const existingMemberships = (await convex.query(
      "organization-members:listByOrgProviderUser",
      {
        organizationId: org._id,
        providerUserId: githubUserId,
      }
    )) as OrganizationMemberDoc[];

    // Check for blocked (admin-removed or user-left), mirror-removed, or active membership
    type MembershipRecord = (typeof existingMemberships)[number];
    let blockedMember: MembershipRecord | null = null;
    let mirrorRemovedMember: MembershipRecord | null = null;
    let activeMember: MembershipRecord | null = null;

    for (const m of existingMemberships) {
      // Both admin removal and voluntary leave block auto-rejoin (require manual re-invite)
      if (
        m.removedAt &&
        (m.removalReason === "admin_action" || m.removalReason === "user_left")
      ) {
        blockedMember = m;
      } else if (m.removedAt && m.removalReason === "github_left") {
        mirrorRemovedMember = m;
      } else if (!m.removedAt) {
        activeMember = m;
      }
    }

    if (blockedMember) {
      const reason =
        blockedMember.removalReason === "user_left"
          ? "voluntarily left"
          : "admin removed";
      console.log(
        `[webhook/organization] User ${githubUsername} blocked from auto-rejoin (${reason}) [delivery: ${deliveryId}]`
      );
      return { status: "blocked", memberAdded: false };
    }

    if (mirrorRemovedMember) {
      // SECURITY: Reset role to "member" on reactivation to prevent privilege escalation.
      // Previously elevated users (admin/owner) who left GitHub org and rejoin
      // should not automatically regain their elevated role.
      await convex.mutation("organization-members:update", {
        id: mirrorRemovedMember._id,
        removedAt: null,
        removalReason: null,
        removedBy: null,
        role: "member",
        updatedAt: Date.now(),
      });
      console.log(
        `[webhook/organization] Reactivated member ${githubUsername} in ${orgLogin} (role reset to member) [delivery: ${deliveryId}]`
      );
      return { status: "reactivated", memberAdded: true };
    }

    if (activeMember) {
      console.log(
        `[webhook/organization] Member ${githubUsername} already exists in ${orgLogin} [delivery: ${deliveryId}]`
      );
      return { status: "cache_invalidated", memberAdded: false };
    }

    // Find user in Detent system by providerUserId (in any org)
    const existingUsers = (await convex.query(
      "organization-members:listByProviderUserId",
      {
        providerUserId: githubUserId,
      }
    )) as OrganizationMemberDoc[];
    const existingUser = existingUsers[0];

    if (!existingUser) {
      // User doesn't exist in Detent - they'll join via sync-user on login
      console.log(
        `[webhook/organization] User ${githubUsername} (GitHub ID: ${githubUserId}) not in Detent, will join on login [delivery: ${deliveryId}]`
      );
      return { status: "cache_invalidated", memberAdded: false };
    }

    // Create membership for existing Detent user
    // Use onConflictDoNothing to handle race conditions gracefully:
    // - Concurrent webhook requests for same user
    // - User already has membership via different path (e.g., manual invite)
    const created = (await convex.mutation(
      "organization-members:createIfMissing",
      {
        organizationId: org._id,
        userId: existingUser.userId,
        role: "member",
        providerUserId: githubUserId,
        providerUsername: githubUsername,
        providerLinkedAt: Date.now(),
        providerVerifiedAt: Date.now(),
        membershipSource: "github_webhook",
      }
    )) as OrganizationMemberDoc | null;

    if (created && !created.removedAt) {
      console.log(
        `[webhook/organization] Auto-added member ${githubUsername} (GitHub ID: ${githubUserId}) to ${orgLogin} [delivery: ${deliveryId}]`
      );
      return { status: "member_added", memberAdded: true };
    }

    // Insert was skipped - user already has membership (race condition or different path)
    console.log(
      `[webhook/organization] Member ${githubUsername} already exists in ${orgLogin} (conflict on userId) [delivery: ${deliveryId}]`
    );
    return { status: "already_member", memberAdded: false };
  } catch (error) {
    console.error(
      `[webhook/organization] DB error adding member to ${orgLogin} [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "organization",
      deliveryId,
    });
    return { status: "cache_invalidated", memberAdded: false };
  }
};

/**
 * Handle GitHub organization member webhooks.
 *
 * Cache invalidation strategy:
 * - Invalidate in-memory cache first (synchronous, per-isolate)
 * - Then invalidate KV cache (async, eventually consistent globally)
 *
 * Auto-sync behavior:
 * - member_added: Auto-add user to Detent org (if they exist in system)
 * - member_removed: Demote user to visitor role (only auto-joined members, never owners)
 *
 * Race condition notes:
 * - KV is eventually consistent, so there's a brief window where stale data
 *   may be served from other regions after invalidation.
 * - In-memory caches in other isolates will naturally expire (5min TTL).
 * - This is acceptable for member list caching - brief staleness is tolerable.
 */
export const handleOrganizationWebhook = async (
  payload: OrganizationPayload,
  env: Env,
  deliveryId = "unknown"
): Promise<MemberSyncResult> => {
  const { action, organization, membership } = payload;

  // Only handle member changes
  if (action !== "member_added" && action !== "member_removed") {
    return { status: "ignored", memberDemoted: false, memberAdded: false };
  }

  const orgLogin = organization.login;
  const membersCacheKey = cacheKey.githubOrgMembers(orgLogin);

  // Invalidate in-memory cache first (immediate, but only affects this isolate)
  deleteFromCache(membersCacheKey);

  // Invalidate KV cache (eventually consistent across all regions)
  try {
    await env["detent-idempotency"].delete(membersCacheKey);
  } catch (kvError) {
    console.error(
      `[webhook/organization] KV delete failed for ${orgLogin} [delivery: ${deliveryId}]:`,
      kvError
    );
  }

  console.log(
    `[webhook/organization] Invalidated member cache for ${orgLogin} (${action}) [delivery: ${deliveryId}]`
  );

  // Validate payload has required fields for member sync
  if (!membership?.user?.id) {
    console.warn(
      `[webhook/organization] Missing membership.user.id in payload for ${orgLogin} [delivery: ${deliveryId}]`
    );
    return {
      status: "cache_invalidated",
      memberDemoted: false,
      memberAdded: false,
    };
  }

  // Sync member based on action
  if (action === "member_removed") {
    return tryDemoteToVisitor(
      env,
      organization.id,
      String(membership.user.id),
      membership.user.login,
      orgLogin,
      deliveryId
    );
  }

  // action === "member_added"
  return tryAutoAddMember(
    env,
    organization.id,
    String(membership.user.id),
    membership.user.login,
    orgLogin,
    deliveryId
  );
};
