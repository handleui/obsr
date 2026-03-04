import type { ConvexHttpClient } from "convex/browser";
import { getConvexClient } from "../../../db/convex";
import { createTokenSecretWithCleanup } from "../../../lib/github-secrets-helper";
import { captureWebhookError } from "../../../lib/sentry";
import { createGitHubService } from "../../../services/github";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type { Env } from "../../../types/env";
import type { InstallationRepositoriesPayload, WebhookContext } from "../types";
import { createTrackedWaitUntil } from "../utils/tracked-background-task";

/**
 * Auto-create DETENT_TOKEN secrets for newly added repos (personal accounts only)
 * Creates a new API key and repo secrets for the added repositories
 *
 * Uses shared helper for API key lifecycle management.
 */
const autoCreateSecretsForNewRepos = async (
  convex: ConvexHttpClient,
  organizationId: string,
  providerAccountLogin: string,
  installationId: string,
  repositories: Array<{ full_name: string }>,
  env: Env
): Promise<void> => {
  const github = createGitHubService(env);
  const token = await github.getInstallationToken(Number(installationId));

  const result = await createTokenSecretWithCleanup({
    convex,
    organizationId,
    providerAccountLogin,
    providerAccountType: "user",
    token,
    repositories,
    keyName: `GitHub Actions (auto - ${repositories.length} repos)`,
  });

  if (result.batchResult?.failed) {
    console.error(
      `[installation_repositories] Failed to create ${result.batchResult.failed}/${repositories.length} repo secrets for ${providerAccountLogin}:`,
      result.batchResult.errors
    );
  }

  console.log(
    `[installation_repositories] Created repo secrets DETENT_TOKEN for ${result.batchResult?.succeeded ?? 0}/${repositories.length} new repos in ${providerAccountLogin}`
  );
};

// Handle installation_repositories events (repos added/removed from installation)
export const handleInstallationRepositoriesEvent = async (
  c: WebhookContext,
  payload: InstallationRepositoriesPayload
) => {
  const { action, installation, repositories_added, repositories_removed } =
    payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[installation_repositories] ${action}: installation ${installation.id}, added=${repositories_added.length}, removed=${repositories_removed.length} [delivery: ${deliveryId}]`
  );

  const convex = getConvexClient(c.env);

  try {
    // Find organization by installation ID
    const orgs = (await convex.query(
      "organizations:listByProviderInstallationId",
      {
        providerInstallationId: String(installation.id),
      }
    )) as Array<{
      _id: string;
      slug: string;
      providerAccountType: "organization" | "user";
      providerAccountLogin?: string | null;
    }>;

    const org = orgs[0];
    if (!org) {
      console.log(
        `[installation_repositories] Organization not found for installation ${installation.id}`
      );
      return c.json({
        message: "organization not found",
        installation_id: installation.id,
      });
    }

    // Handle added repositories
    if (repositories_added.length > 0) {
      await convex.mutation("projects:syncFromGitHub", {
        organizationId: org._id,
        repos: repositories_added.map((repo) => ({
          id: String(repo.id),
          name: repo.name,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
          isPrivate: repo.private,
        })),
        syncRemoved: false,
      });

      console.log(
        `[installation_repositories] Created ${repositories_added.length} projects for organization ${org.slug}`
      );

      // For personal accounts, auto-create repo secrets for the new repos
      // (Org accounts use org-wide secrets, so no action needed)
      if (org.providerAccountType === "user" && org.providerAccountLogin) {
        // Use tracked waitUntil for proper error capture and Sentry reporting
        const waitUntilTracked = createTrackedWaitUntil(c.executionCtx, {
          deliveryId,
          repository: org.providerAccountLogin, // Use account login as repository context
          installationId: installation.id,
        });

        waitUntilTracked(
          (async () => {
            await autoCreateSecretsForNewRepos(
              getConvexClient(c.env),
              org._id,
              org.providerAccountLogin as string,
              String(installation.id),
              repositories_added,
              c.env
            );
          })(),
          { operation: "auto_create_secrets_new_repos" }
        );
      }
    }

    // Handle removed repositories (soft-delete) - batch update for performance
    if (repositories_removed.length > 0) {
      const repoIds = repositories_removed.map((repo) => String(repo.id));
      await convex.mutation("projects:softDeleteByOrgRepoIds", {
        organizationId: org._id,
        providerRepoIds: repoIds,
        removedAt: Date.now(),
      });

      console.log(
        `[installation_repositories] Soft-deleted ${repositories_removed.length} projects for organization ${org.slug}`
      );
    }

    return c.json({
      message: "installation_repositories processed",
      organization_id: org._id,
      organization_slug: org.slug,
      projects_added: repositories_added.length,
      projects_removed: repositories_removed.length,
    });
  } catch (error) {
    console.error(
      `[installation_repositories] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "installation_repositories",
      deliveryId,
      installationId: installation.id,
    });
    return c.json(
      {
        message: "installation_repositories error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        installationId: installation.id,
      },
      500
    );
  }
};
