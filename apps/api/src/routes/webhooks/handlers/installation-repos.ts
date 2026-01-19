import { eq, inArray } from "drizzle-orm";
import { createDb } from "../../../db/client";
import { apiKeys, organizations, projects } from "../../../db/schema";
import { generateApiKey, hashApiKey } from "../../../lib/crypto";
import { createRepoSecretsBatched } from "../../../lib/github-secrets-helper";
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
 * Note: Cleans up API key if all secret creations fail to prevent orphaned keys.
 */
const autoCreateSecretsForNewRepos = async (
  db: DbClient,
  organizationId: string,
  providerAccountLogin: string,
  installationId: string,
  repositories: Array<{ full_name: string }>,
  env: Env
): Promise<void> => {
  // Generate a new API key for these repos
  const keyId = crypto.randomUUID();
  const apiKey = generateApiKey();
  const keyHash = await hashApiKey(apiKey);
  const keyPrefix = apiKey.substring(0, 8);

  await db.insert(apiKeys).values({
    id: keyId,
    organizationId,
    keyHash,
    keyPrefix,
    name: `GitHub Actions (auto - ${repositories.length} repos)`,
  });

  // Track whether any secrets were created to avoid deleting keys with active secrets
  let secretsCreated = false;

  try {
    // Get installation token to authenticate with GitHub API
    const github = createGitHubService(env);
    const token = await github.getInstallationToken(Number(installationId));

    // Create repo secrets with batched execution and concurrency control
    const results = await createRepoSecretsBatched(repositories, apiKey, token);

    secretsCreated = results.succeeded > 0;

    if (results.failed > 0) {
      console.error(
        `[installation_repositories] Failed to create ${results.failed}/${repositories.length} repo secrets for ${providerAccountLogin}:`,
        results.errors
      );
    }

    // If ALL repos failed, clean up the orphaned API key
    if (results.succeeded === 0 && repositories.length > 0) {
      await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
      throw new Error(
        `All ${repositories.length} repo secret creations failed for ${providerAccountLogin}`
      );
    }

    console.log(
      `[installation_repositories] Created repo secrets DETENT_TOKEN for ${results.succeeded}/${repositories.length} new repos in ${providerAccountLogin}`
    );
  } catch (error) {
    // Only clean up API key if no secrets were created
    // If partial success occurred, keep the key so existing secrets remain valid
    if (!secretsCreated) {
      try {
        await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
        console.log(
          `[installation_repositories] Cleaned up orphaned API key ${keyId} after secret creation failure`
        );
      } catch (deleteError) {
        console.error(
          `[installation_repositories] ORPHAN_KEY: Failed to delete API key ${keyId} for org ${organizationId}:`,
          deleteError
        );
      }
    }
    throw error;
  }
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
