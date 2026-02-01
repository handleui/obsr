import type { ConvexHttpClient } from "convex/browser";
import { getConvexClient } from "../../../db/convex";
import { verifyGitHubMembership } from "../../../lib/github-membership";
import { createTokenSecretWithCleanup } from "../../../lib/github-secrets-helper";
import {
  createProviderSlug,
  DEFAULT_ORG_SETTINGS,
} from "../../../lib/org-settings";
import { captureWebhookError } from "../../../lib/sentry";
import { createGitHubService } from "../../../services/github";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type { DbClient } from "../../../services/webhooks/types";
import type { Env } from "../../../types/env";
import type { InstallationPayload, WebhookContext } from "../types";
import { createTrackedWaitUntil } from "../utils/tracked-background-task";

const autoLinkInstaller = async (
  convex: DbClient,
  organizationId: string,
  installerGithubId: string,
  installerUsername: string,
  orgLogin: string,
  installationId: string,
  accountType: "organization" | "user",
  env: Env
): Promise<boolean> => {
  // Check if installer already has a Detent account (via any org membership with matching GitHub ID)
  const existingMembers = (await convex.query(
    "organization-members:listByProviderUserId",
    {
      providerUserId: installerGithubId,
    }
  )) as Array<{ userId: string }>;

  const existingMember = existingMembers[0];
  if (!existingMember) {
    // User doesn't exist in Detent system yet - will be linked via sync-identity endpoint later
    return false;
  }

  // Check if they already have active membership to this specific org
  const existingMembership = (await convex.query(
    "organization-members:getByOrgUser",
    {
      organizationId,
      userId: existingMember.userId,
    }
  )) as { _id: string; removedAt?: number | null } | null;

  if (existingMembership && !existingMembership.removedAt) {
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
  await convex.mutation("organization-members:createIfMissing", {
    organizationId,
    userId: existingMember.userId,
    role: "owner",
    providerUserId: installerGithubId,
    providerUsername: installerUsername,
    providerLinkedAt: Date.now(),
    providerVerifiedAt: Date.now(),
    membershipSource: "installer",
  });

  console.log(
    `[webhook] Auto-linked installer ${installerGithubId} (${installerUsername}) as owner to org ${organizationId}`
  );
  return true;
};

interface AutoCreateSecretParams {
  convex: ConvexHttpClient;
  organizationId: string;
  providerAccountLogin: string;
  providerAccountType: "organization" | "user";
  installationId: string;
  repositories: Array<{ full_name: string }>;
  env: Env;
}

/**
 * Auto-create DETENT_TOKEN secret in GitHub after installation
 * - For organizations: creates org-level secret (accessible to all repos)
 * - For personal accounts: creates repo-level secret for each repository
 *
 * Uses shared helper for API key lifecycle management.
 */
const autoCreateSecret = async ({
  convex,
  organizationId,
  providerAccountLogin,
  providerAccountType,
  installationId,
  repositories,
  env,
}: AutoCreateSecretParams): Promise<void> => {
  const github = createGitHubService(env);
  const token = await github.getInstallationToken(Number(installationId));

  const result = await createTokenSecretWithCleanup({
    convex,
    organizationId,
    providerAccountLogin,
    providerAccountType,
    token,
    repositories,
    keyName: "GitHub Actions (auto)",
  });

  if (providerAccountType === "organization") {
    console.log(
      `[installation] Created org secret DETENT_TOKEN for ${providerAccountLogin}`
    );
  } else {
    if (result.batchResult?.failed) {
      console.error(
        `[installation] Failed to create ${result.batchResult.failed}/${repositories.length} repo secrets for ${providerAccountLogin}:`,
        result.batchResult.errors
      );
    }
    console.log(
      `[installation] Created repo secrets DETENT_TOKEN for ${result.batchResult?.succeeded ?? 0}/${repositories.length} repos in ${providerAccountLogin}`
    );
  }
};

/**
 * Trigger async secret creation with proper DB connection management
 * Returns a promise that can be passed to waitUntil
 */
const triggerSecretCreation = async (
  orgId: string,
  providerAccountLogin: string,
  providerAccountType: "organization" | "user",
  installationId: string,
  repositories: Array<{ full_name: string }>,
  env: Env
): Promise<void> => {
  const convex = getConvexClient(env);
  await autoCreateSecret({
    convex,
    organizationId: orgId,
    providerAccountLogin,
    providerAccountType,
    installationId,
    repositories,
    env,
  });
};

const generateUniqueSlug = async (
  convex: DbClient,
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

  // Return the first available slug
  for (const slug of potentialSlugs) {
    const existing = (await convex.query("organizations:getBySlug", {
      slug,
    })) as { _id: string } | null;
    if (!existing) {
      return slug;
    }
  }

  // Fallback: append random suffix (all 11 potential slugs are taken)
  return `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
};

// Handle installation.created event - create organization and projects
const handleInstallationCreated = async (
  convex: DbClient,
  installation: InstallationPayload["installation"],
  repositories: InstallationPayload["repositories"],
  sender: InstallationPayload["sender"],
  env: Env
): Promise<
  | { organizationId: string; slug: string }
  | { existing: true; id: string; slug: string; reactivated?: boolean }
> => {
  const { account } = installation;
  const now = Date.now();

  // Check by providerAccountId first (survives reinstalls - GitHub org/user ID is immutable)
  const existingByAccount = (await convex.query(
    "organizations:getByProviderAccount",
    {
      provider: "github",
      providerAccountId: String(account.id),
    }
  )) as { _id: string; slug: string; deletedAt?: number | null } | null;

  if (existingByAccount) {
    if (existingByAccount.deletedAt) {
      // Reactivate soft-deleted org with new installation
      await convex.mutation("organizations:update", {
        id: existingByAccount._id,
        deletedAt: null,
        providerInstallationId: String(installation.id),
        installerGithubId: String(sender.id),
        providerAccountLogin: account.login,
        providerAvatarUrl: account.avatar_url ?? null,
        updatedAt: now,
      });

      await convex.mutation("projects:clearRemovedByOrg", {
        organizationId: existingByAccount._id,
        updatedAt: now,
      });

      console.log(
        `[installation] Reactivated soft-deleted organization: ${existingByAccount.slug} (${existingByAccount._id})`
      );

      if (repositories && repositories.length > 0) {
        await convex.mutation("projects:syncFromGitHub", {
          organizationId: existingByAccount._id,
          repos: repositories.map((repo) => ({
            id: String(repo.id),
            name: repo.name,
            fullName: repo.full_name,
            defaultBranch: repo.default_branch,
            isPrivate: repo.private,
          })),
          syncRemoved: false,
        });
      }

      await autoLinkInstaller(
        convex,
        existingByAccount._id,
        String(sender.id),
        sender.login,
        account.login,
        String(installation.id),
        account.type === "Organization" ? "organization" : "user",
        env
      );

      return {
        existing: true,
        id: existingByAccount._id,
        slug: existingByAccount.slug,
        reactivated: true,
      };
    }

    await convex.mutation("organizations:update", {
      id: existingByAccount._id,
      providerInstallationId: String(installation.id),
      providerAccountLogin: account.login,
      providerAvatarUrl: account.avatar_url ?? null,
      updatedAt: now,
    });

    console.log(
      `[installation] Organization already exists for account ${account.id}, updated installation: ${existingByAccount.slug}`
    );
    return {
      existing: true,
      id: existingByAccount._id,
      slug: existingByAccount.slug,
    };
  }

  // Fallback: check by installation ID (handles edge case of duplicate webhooks)
  const existingByInstall = (await convex.query(
    "organizations:listByProviderInstallationId",
    {
      providerInstallationId: String(installation.id),
    }
  )) as Array<{ _id: string; slug: string }>;

  if (existingByInstall[0]) {
    console.log(
      `[installation] Organization already exists for installation ${installation.id}: ${existingByInstall[0].slug}`
    );
    return {
      existing: true,
      id: existingByInstall[0]._id,
      slug: existingByInstall[0].slug,
    };
  }

  // Create organization when app is installed
  // Use provider-prefixed slug format: gh/login or gl/login
  const baseSlug = createProviderSlug("github", account.login);
  const slug = await generateUniqueSlug(convex, baseSlug);

  const organizationId = (await convex.mutation("organizations:create", {
    name: account.login,
    slug,
    provider: "github",
    providerAccountId: String(account.id),
    providerAccountLogin: account.login,
    providerAccountType:
      account.type === "Organization" ? "organization" : "user",
    providerInstallationId: String(installation.id),
    providerAvatarUrl: account.avatar_url ?? null,
    installerGithubId: String(sender.id),
    settings: DEFAULT_ORG_SETTINGS,
    createdAt: now,
    updatedAt: now,
  })) as string;

  console.log(
    `[installation] Created organization: ${slug} (${organizationId})`
  );

  if (repositories && repositories.length > 0) {
    await convex.mutation("projects:syncFromGitHub", {
      organizationId,
      repos: repositories.map((repo) => ({
        id: String(repo.id),
        name: repo.name,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        isPrivate: repo.private,
      })),
      syncRemoved: false,
    });

    console.log(
      `[installation] Created ${repositories.length} projects for organization ${slug}`
    );
  }

  await autoLinkInstaller(
    convex,
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

// Handle the "created" action for installation events
const handleCreatedAction = async (
  c: WebhookContext,
  convex: DbClient,
  installation: InstallationPayload["installation"],
  repositories: InstallationPayload["repositories"],
  sender: InstallationPayload["sender"]
) => {
  const { account } = installation;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  const result = await handleInstallationCreated(
    convex,
    installation,
    repositories,
    sender,
    c.env
  );

  // Auto-create DETENT_TOKEN secret (fire-and-forget)
  // For new and reactivated installations - old key may be compromised
  const shouldCreateSecret = !("existing" in result) || result.reactivated;
  if (shouldCreateSecret && repositories?.length) {
    const orgId = "existing" in result ? result.id : result.organizationId;

    // Use tracked waitUntil for proper error capture and Sentry reporting
    // Wrapped in try-catch because executionCtx may not be available in tests
    try {
      const waitUntilTracked = createTrackedWaitUntil(c.executionCtx, {
        deliveryId,
        repository: account.login, // Use account login as repository context
        installationId: installation.id,
      });

      waitUntilTracked(
        triggerSecretCreation(
          orgId,
          account.login,
          account.type === "Organization" ? "organization" : "user",
          String(installation.id),
          repositories,
          c.env
        ),
        { operation: "auto_create_secret" }
      );
    } catch {
      // executionCtx not available (e.g., in tests) - skip background task
    }
  }

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

  const convex = getConvexClient(c.env);

  try {
    switch (action) {
      case "created":
        return await handleCreatedAction(
          c,
          convex,
          installation,
          repositories,
          payload.sender
        );

      case "deleted": {
        // Get org with polarCustomerId before soft-deleting
        const orgs = (await convex.query(
          "organizations:listByProviderInstallationId",
          {
            providerInstallationId: String(installation.id),
          }
        )) as Array<{ _id: string; polarCustomerId?: string | null }>;

        const orgToDelete = orgs[0];

        // Cancel Polar subscriptions if customer exists (fire-and-forget)
        if (orgToDelete?.polarCustomerId && c.env.POLAR_ACCESS_TOKEN) {
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
            orgToDelete.polarCustomerId
          )
            .then((count) => {
              console.log(
                `[installation] Canceled ${count} Polar subscription(s) for org ${orgToDelete?._id}`
              );
            })
            .catch((error) => {
              console.error(
                "[installation] Failed to cancel Polar subscriptions:",
                error
              );
            });
        }

        if (orgToDelete) {
          await convex.mutation("organizations:update", {
            id: orgToDelete._id,
            deletedAt: Date.now(),
            updatedAt: Date.now(),
          });
        }

        console.log(
          `[installation] Soft-deleted organization for installation ${installation.id}`
        );

        return c.json({
          message: "installation deleted",
          account: account.login,
        });
      }

      case "suspend": {
        const orgs = (await convex.query(
          "organizations:listByProviderInstallationId",
          {
            providerInstallationId: String(installation.id),
          }
        )) as Array<{ _id: string }>;
        if (orgs[0]) {
          await convex.mutation("organizations:update", {
            id: orgs[0]._id,
            suspendedAt: Date.now(),
            updatedAt: Date.now(),
          });
        }

        return c.json({
          message: "installation suspended",
          account: account.login,
        });
      }

      case "unsuspend": {
        const orgs = (await convex.query(
          "organizations:listByProviderInstallationId",
          {
            providerInstallationId: String(installation.id),
          }
        )) as Array<{ _id: string }>;
        if (orgs[0]) {
          await convex.mutation("organizations:update", {
            id: orgs[0]._id,
            suspendedAt: null,
            updatedAt: Date.now(),
          });
        }

        return c.json({
          message: "installation unsuspended",
          account: account.login,
        });
      }

      case "new_permissions_accepted": {
        // User accepted new permissions requested by the app
        // Update the organization's updatedAt to track this event
        const orgs = (await convex.query(
          "organizations:listByProviderInstallationId",
          {
            providerInstallationId: String(installation.id),
          }
        )) as Array<{ _id: string }>;
        if (orgs[0]) {
          await convex.mutation("organizations:update", {
            id: orgs[0]._id,
            updatedAt: Date.now(),
          });
        }

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
  }
};
