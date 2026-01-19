import { eq, inArray } from "drizzle-orm";
import { createDb } from "../../../db/client";
import { organizations, projects } from "../../../db/schema";
import { createTokenSecretWithCleanup } from "../../../lib/github-secrets-helper";
import { captureWebhookError } from "../../../lib/sentry";
import { createGitHubService } from "../../../services/github";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type { DbClient } from "../../../services/webhooks/types";
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
  db: DbClient,
  organizationId: string,
  providerAccountLogin: string,
  installationId: string,
  repositories: Array<{ full_name: string }>,
  env: Env
): Promise<void> => {
  const github = createGitHubService(env);
  const token = await github.getInstallationToken(Number(installationId));

  const result = await createTokenSecretWithCleanup({
    db,
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

  const { db, client } = await createDb(c.env);

  try {
    // Find organization by installation ID
    const orgResult = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        providerAccountType: organizations.providerAccountType,
        providerAccountLogin: organizations.providerAccountLogin,
      })
      .from(organizations)
      .where(eq(organizations.providerInstallationId, String(installation.id)))
      .limit(1);

    const org = orgResult[0];
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
      const projectValues = repositories_added.map((repo) => ({
        id: crypto.randomUUID(),
        organizationId: org.id,
        handle: repo.name.toLowerCase(), // URL-friendly handle defaults to repo name
        providerRepoId: String(repo.id),
        providerRepoName: repo.name,
        providerRepoFullName: repo.full_name,
        isPrivate: repo.private,
      }));

      await db.insert(projects).values(projectValues).onConflictDoNothing();

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
            const { db: secretDb, client: secretClient } = await createDb(
              c.env
            );
            try {
              await autoCreateSecretsForNewRepos(
                secretDb,
                org.id,
                org.providerAccountLogin as string,
                String(installation.id),
                repositories_added,
                c.env
              );
            } finally {
              await secretClient.end();
            }
          })(),
          { operation: "auto_create_secrets_new_repos" }
        );
      }
    }

    // Handle removed repositories (soft-delete) - batch update for performance
    if (repositories_removed.length > 0) {
      const repoIds = repositories_removed.map((repo) => String(repo.id));
      await db
        .update(projects)
        .set({ removedAt: new Date(), updatedAt: new Date() })
        .where(inArray(projects.providerRepoId, repoIds));

      console.log(
        `[installation_repositories] Soft-deleted ${repositories_removed.length} projects for organization ${org.slug}`
      );
    }

    return c.json({
      message: "installation_repositories processed",
      organization_id: org.id,
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
  } finally {
    await client.end();
  }
};
