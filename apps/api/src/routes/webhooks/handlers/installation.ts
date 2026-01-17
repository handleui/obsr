import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { createDb } from "../../../db/client";
import {
  createProviderSlug,
  organizationMembers,
  organizations,
  projects,
} from "../../../db/schema";
import { verifyGitHubMembership } from "../../../lib/github-membership";
import { captureWebhookError } from "../../../lib/sentry";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type { DbClient } from "../../../services/webhooks/types";
import type { Env } from "../../../types/env";
import type { InstallationPayload, WebhookContext } from "../types";

const autoLinkInstaller = async (
  db: DbClient,
  organizationId: string,
  installerGithubId: string,
  installerUsername: string,
  orgLogin: string,
  installationId: string,
  accountType: "organization" | "user",
  env: Env
): Promise<boolean> => {
  // Check if installer already has a Detent account (via any org membership with matching GitHub ID)
  const existingMember = await db
    .select({
      userId: organizationMembers.userId,
    })
    .from(organizationMembers)
    .where(eq(organizationMembers.providerUserId, installerGithubId))
    .limit(1);

  if (!existingMember[0]) {
    // User doesn't exist in Detent system yet - will be linked via sync-identity endpoint later
    return false;
  }

  // Check if they already have active membership to this specific org
  const existingMembership = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, existingMember[0].userId),
        eq(organizationMembers.organizationId, organizationId),
        isNull(organizationMembers.removedAt)
      )
    )
    .limit(1);

  if (existingMembership[0]) {
    // Already an active member of this org
    console.log(
      `[webhook] Installer ${installerGithubId} already has membership to org ${organizationId}`
    );
    return false;
  }

  // For organizations: verify installer is currently a GitHub admin
  // Security: Only GitHub admins should auto-claim as Detent owner
  // This mirrors the check in sync-identity endpoint for consistency
  if (accountType === "organization") {
    const membership = await verifyGitHubMembership(
      installerUsername,
      orgLogin,
      installationId,
      env
    );

    if (!(membership.isMember && membership.role === "admin")) {
      console.log(
        `[webhook] Installer ${installerUsername} is not a GitHub admin of ${orgLogin}, skipping owner auto-link`
      );
      return false;
    }
  }
  // For personal accounts: installer is the account owner by definition, no verification needed

  // Create owner membership for the installer
  await db.insert(organizationMembers).values({
    id: crypto.randomUUID(),
    organizationId,
    userId: existingMember[0].userId,
    role: "owner",
    providerUserId: installerGithubId,
    providerUsername: installerUsername,
    providerLinkedAt: new Date(),
    membershipSource: "installer",
  });

  console.log(
    `[webhook] Auto-linked installer ${installerGithubId} (${installerUsername}) as owner to org ${organizationId}`
  );
  return true;
};

const generateUniqueSlug = async (
  db: DbClient,
  baseSlug: string
): Promise<string> => {
  const maxSlugAttempts = 10;

  // Generate all potential slugs upfront: baseSlug, baseSlug-1, baseSlug-2, ...
  const potentialSlugs = [
    baseSlug,
    ...Array.from(
      { length: maxSlugAttempts },
      (_, i) => `${baseSlug}-${i + 1}`
    ),
  ];

  // Single query to find all existing slugs that match our potential slugs
  const existingSlugs = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(inArray(organizations.slug, potentialSlugs));

  const existingSlugSet = new Set(existingSlugs.map((r) => r.slug));

  // Return the first available slug
  for (const slug of potentialSlugs) {
    if (!existingSlugSet.has(slug)) {
      return slug;
    }
  }

  // Fallback: append random suffix (all 11 potential slugs are taken)
  return `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
};

// Handle installation.created event - create organization and projects
const handleInstallationCreated = async (
  db: DbClient,
  installation: InstallationPayload["installation"],
  repositories: InstallationPayload["repositories"],
  sender: InstallationPayload["sender"],
  env: Env
): Promise<
  | { organizationId: string; slug: string }
  | { existing: true; id: string; slug: string; reactivated?: boolean }
> => {
  const { account } = installation;

  // Check by providerAccountId first (survives reinstalls - GitHub org/user ID is immutable)
  const existingByAccount = await db
    .select({
      id: organizations.id,
      slug: organizations.slug,
      deletedAt: organizations.deletedAt,
    })
    .from(organizations)
    .where(
      and(
        eq(organizations.provider, "github"),
        eq(organizations.providerAccountId, String(account.id))
      )
    )
    .limit(1);

  if (existingByAccount[0]) {
    const existing = existingByAccount[0];

    if (existing.deletedAt) {
      // Reactivate soft-deleted org with new installation
      await db
        .update(organizations)
        .set({
          deletedAt: null,
          providerInstallationId: String(installation.id),
          installerGithubId: String(sender.id),
          providerAccountLogin: account.login, // May have changed
          providerAvatarUrl: account.avatar_url ?? null,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, existing.id));

      // Reactivate soft-deleted projects for this org
      await db
        .update(projects)
        .set({
          removedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projects.organizationId, existing.id),
            isNotNull(projects.removedAt)
          )
        );

      console.log(
        `[installation] Reactivated soft-deleted organization: ${existing.slug} (${existing.id})`
      );

      // Create any new projects that weren't in the previous installation
      if (repositories && repositories.length > 0) {
        const projectValues = repositories.map((repo) => ({
          id: crypto.randomUUID(),
          organizationId: existing.id,
          handle: repo.name.toLowerCase(),
          providerRepoId: String(repo.id),
          providerRepoName: repo.name,
          providerRepoFullName: repo.full_name,
          isPrivate: repo.private,
        }));

        await db.insert(projects).values(projectValues).onConflictDoNothing();
      }

      // Try to auto-link the installer if they have an existing Detent account
      await autoLinkInstaller(
        db,
        existing.id,
        String(sender.id),
        sender.login,
        account.login,
        String(installation.id),
        account.type === "Organization" ? "organization" : "user",
        env
      );

      return {
        existing: true,
        id: existing.id,
        slug: existing.slug,
        reactivated: true,
      };
    }

    // Active org exists - idempotency: update installation ID and return
    await db
      .update(organizations)
      .set({
        providerInstallationId: String(installation.id),
        providerAccountLogin: account.login, // May have changed
        providerAvatarUrl: account.avatar_url ?? null,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, existing.id));

    console.log(
      `[installation] Organization already exists for account ${account.id}, updated installation: ${existing.slug}`
    );
    return { existing: true, id: existing.id, slug: existing.slug };
  }

  // Fallback: check by installation ID (handles edge case of duplicate webhooks)
  const existingByInstall = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.providerInstallationId, String(installation.id)))
    .limit(1);

  if (existingByInstall[0]) {
    console.log(
      `[installation] Organization already exists for installation ${installation.id}: ${existingByInstall[0].slug}`
    );
    return {
      existing: true,
      id: existingByInstall[0].id,
      slug: existingByInstall[0].slug,
    };
  }

  // Create organization when app is installed
  const organizationId = crypto.randomUUID();
  // Use provider-prefixed slug format: gh/login or gl/login
  const baseSlug = createProviderSlug("github", account.login);
  const slug = await generateUniqueSlug(db, baseSlug);

  await db.insert(organizations).values({
    id: organizationId,
    name: account.login,
    slug,
    provider: "github",
    providerAccountId: String(account.id),
    providerAccountLogin: account.login,
    providerAccountType:
      account.type === "Organization" ? "organization" : "user",
    providerInstallationId: String(installation.id),
    providerAvatarUrl: account.avatar_url ?? null,
    // Track installer's GitHub ID (immutable) for owner role assignment
    installerGithubId: String(sender.id),
  });

  console.log(
    `[installation] Created organization: ${slug} (${organizationId})`
  );

  // Create projects for initial repositories
  if (repositories && repositories.length > 0) {
    const projectValues = repositories.map((repo) => ({
      id: crypto.randomUUID(),
      organizationId,
      handle: repo.name.toLowerCase(), // URL-friendly handle defaults to repo name
      providerRepoId: String(repo.id),
      providerRepoName: repo.name,
      providerRepoFullName: repo.full_name,
      isPrivate: repo.private,
    }));

    await db.insert(projects).values(projectValues).onConflictDoNothing();

    console.log(
      `[installation] Created ${repositories.length} projects for organization ${slug}`
    );
  }

  // Try to auto-link the installer if they have an existing Detent account
  await autoLinkInstaller(
    db,
    organizationId,
    String(sender.id),
    sender.login,
    account.login,
    String(installation.id),
    account.type === "Organization" ? "organization" : "user",
    env
  );

  return { organizationId, slug };
};

// Handle installation events (GitHub App installed/uninstalled)
export const handleInstallationEvent = async (
  c: WebhookContext,
  payload: InstallationPayload
) => {
  const { action, installation, repositories } = payload;
  const { account } = installation;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[installation] ${action}: ${account.login} (${account.type}, installation ${installation.id}) [delivery: ${deliveryId}]`
  );

  const { db, client } = await createDb(c.env);

  try {
    switch (action) {
      case "created": {
        const result = await handleInstallationCreated(
          db,
          installation,
          repositories,
          payload.sender,
          c.env
        );

        if ("existing" in result) {
          return c.json({
            message: result.reactivated
              ? "installation reactivated"
              : "installation already exists",
            organization_id: result.id,
            organization_slug: result.slug,
            account: account.login,
            reactivated: result.reactivated ?? false,
          });
        }

        return c.json({
          message: "installation created",
          organization_id: result.organizationId,
          organization_slug: result.slug,
          account: account.login,
          projects_created: repositories?.length ?? 0,
        });
      }

      case "deleted": {
        // Get org with polarCustomerId before soft-deleting
        const orgToDelete = await db
          .select({
            id: organizations.id,
            polarCustomerId: organizations.polarCustomerId,
          })
          .from(organizations)
          .where(
            eq(organizations.providerInstallationId, String(installation.id))
          )
          .limit(1);

        // Cancel Polar subscriptions if customer exists (fire-and-forget)
        if (orgToDelete[0]?.polarCustomerId && c.env.POLAR_ACCESS_TOKEN) {
          const {
            cancelCustomerSubscriptions,
            createPolarClient,
            getPolarOrgId,
          } = await import("../../../services/polar");

          const polar = createPolarClient(c.env);
          const polarOrgId = getPolarOrgId(c.env);
          cancelCustomerSubscriptions(
            polar,
            polarOrgId,
            orgToDelete[0].polarCustomerId
          )
            .then((count) => {
              console.log(
                `[installation] Canceled ${count} Polar subscription(s) for org ${orgToDelete[0]?.id}`
              );
            })
            .catch((error) => {
              console.error(
                "[installation] Failed to cancel Polar subscriptions:",
                error
              );
            });
        }

        await db
          .update(organizations)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            eq(organizations.providerInstallationId, String(installation.id))
          );

        console.log(
          `[installation] Soft-deleted organization for installation ${installation.id}`
        );

        return c.json({
          message: "installation deleted",
          account: account.login,
        });
      }

      case "suspend": {
        await db
          .update(organizations)
          .set({ suspendedAt: new Date(), updatedAt: new Date() })
          .where(
            eq(organizations.providerInstallationId, String(installation.id))
          );

        return c.json({
          message: "installation suspended",
          account: account.login,
        });
      }

      case "unsuspend": {
        await db
          .update(organizations)
          .set({ suspendedAt: null, updatedAt: new Date() })
          .where(
            eq(organizations.providerInstallationId, String(installation.id))
          );

        return c.json({
          message: "installation unsuspended",
          account: account.login,
        });
      }

      case "new_permissions_accepted": {
        // User accepted new permissions requested by the app
        // Update the organization's updatedAt to track this event
        await db
          .update(organizations)
          .set({ updatedAt: new Date() })
          .where(
            eq(organizations.providerInstallationId, String(installation.id))
          );

        console.log(
          `[installation] New permissions accepted for installation ${installation.id}`
        );

        return c.json({
          message: "permissions updated",
          account: account.login,
        });
      }

      default:
        return c.json({ message: "ignored", action });
    }
  } catch (error) {
    console.error(
      `[installation] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "installation",
      deliveryId,
      installationId: installation.id,
    });
    return c.json(
      {
        message: "installation error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        account: account.login,
      },
      500
    );
  } finally {
    await client.end();
  }
};
