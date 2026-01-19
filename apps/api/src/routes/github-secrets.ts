/**
 * GitHub Secrets Management
 *
 * Injects DETENT_TOKEN as a secret in GitHub (org-level or repo-level).
 * This enables the Detent GitHub Action to authenticate with the API.
 *
 * - Organizations: Creates org-level secret (accessible to all/private/selected repos)
 * - Personal accounts: Must use repo-level secrets via separate endpoint
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { apiKeys } from "../db/schema";
import { generateApiKey, hashApiKey } from "../lib/crypto";
import { encryptSecretForGitHub } from "../lib/github-crypto";
import { getOrgPublicKey, putOrgSecret } from "../lib/github-secrets-helper";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  requireRole,
} from "../middleware/github-org-access";
import { createGitHubService } from "../services/github";
import type { Env } from "../types/env";

// GitHub secret names must be uppercase with underscores only, starting with a letter
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

interface InjectSecretRequest {
  secret_name?: string; // Default: "DETENT_TOKEN"
  visibility?: "all" | "private" | "selected";
  repository_ids?: number[]; // Required if visibility = "selected"
}

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /:orgId/github-secrets
 * Inject DETENT_TOKEN as a GitHub org secret
 *
 * This creates a new API key (or uses existing) and injects it
 * into the GitHub organization's secrets using the org's installation.
 */
app.post(
  "/:orgId/github-secrets",
  githubOrgAccessMiddleware,
  requireRole("owner", "admin"),
  async (c) => {
    const orgAccess = c.get("orgAccess") as OrgAccessContext;
    const { organization } = orgAccess;

    // Validate this is a GitHub org with installation
    if (organization.provider !== "github") {
      return c.json({ error: "Only GitHub organizations are supported" }, 400);
    }

    if (!organization.providerInstallationId) {
      return c.json({ error: "GitHub App not installed" }, 400);
    }

    const body: InjectSecretRequest = await c.req
      .json<InjectSecretRequest>()
      .catch(() => ({}));
    const secretName = body.secret_name ?? "DETENT_TOKEN";
    const visibility = body.visibility ?? "all";

    // Validate secret name
    if (!SECRET_NAME_PATTERN.test(secretName)) {
      return c.json(
        { error: "secret_name must be uppercase with underscores only" },
        400
      );
    }

    if (visibility === "selected" && !body.repository_ids?.length) {
      return c.json(
        { error: "repository_ids required when visibility is 'selected'" },
        400
      );
    }

    const github = createGitHubService(c.env);
    const installationId = Number(organization.providerInstallationId);
    const token = await github.getInstallationToken(installationId);

    const { db, client } = await createDb(c.env);
    let keyId: string | undefined;

    try {
      // Create a new API key for this injection
      keyId = crypto.randomUUID();
      const apiKey = generateApiKey();
      const keyHash = await hashApiKey(apiKey);
      const keyPrefix = apiKey.substring(0, 8); // "dtk_XXXX"

      await db.insert(apiKeys).values({
        id: keyId,
        organizationId: organization.id,
        keyHash,
        keyPrefix,
        name: `GitHub Actions (${secretName})`,
      });

      // Get GitHub's public key and encrypt the API key
      const publicKey = await getOrgPublicKey(
        organization.providerAccountLogin as string,
        token
      );
      const encryptedValue = encryptSecretForGitHub(apiKey, publicKey.key);

      // Create/update the org secret
      await putOrgSecret(
        organization.providerAccountLogin as string,
        secretName,
        encryptedValue,
        publicKey.key_id,
        visibility,
        token,
        body.repository_ids
      );

      console.log(
        `[github-secrets] Injected ${secretName} into ${organization.providerAccountLogin}`
      );

      return c.json({
        success: true,
        secret_name: secretName,
        visibility,
        api_key_id: keyId,
      });
    } catch (error) {
      // Clean up the API key if creation failed
      if (keyId) {
        try {
          await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
        } catch (deleteError) {
          // CRITICAL: Orphaned API key - key exists in DB but no corresponding GitHub secret
          console.error(
            `[github-secrets] ORPHAN_KEY: Failed to delete API key after error. keyId=${keyId}, orgId=${organization.id}`,
            deleteError
          );
        }
      }

      // Log full error details server-side for debugging
      const fullErrorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[github-secrets] Failed to inject secret: ${fullErrorMessage}`
      );

      // Return sanitized error message to client to prevent information leakage
      // Don't expose GitHub API response details or internal error info
      return c.json(
        {
          error: "Failed to create GitHub secret",
        },
        500
      );
    } finally {
      await client.end();
    }
  }
);

export default app;
