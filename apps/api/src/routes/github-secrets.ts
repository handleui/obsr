/**
 * GitHub Secrets Management
 *
 * Injects DETENT_TOKEN as an organization secret in GitHub.
 * This enables the Detent GitHub Action to authenticate with the API.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { apiKeys } from "../db/schema";
import { generateApiKey, hashApiKey } from "../lib/crypto";
import { encryptSecretForGitHub } from "../lib/github-crypto";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  requireRole,
} from "../middleware/github-org-access";
import { createGitHubService } from "../services/github";
import type { Env } from "../types/env";

const GITHUB_API = "https://api.github.com";

// GitHub secret names must be uppercase with underscores only, starting with a letter
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

interface InjectSecretRequest {
  secret_name?: string; // Default: "DETENT_TOKEN"
  visibility?: "all" | "private" | "selected";
  repository_ids?: number[]; // Required if visibility = "selected"
}

interface GitHubPublicKeyResponse {
  key_id: string;
  key: string;
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
    try {
      // Create a new API key for this injection
      const keyId = crypto.randomUUID();
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

      // Step 1: Get GitHub's public key for this org
      const publicKeyResponse = await fetch(
        `${GITHUB_API}/orgs/${organization.providerAccountLogin}/actions/secrets/public-key`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Detent-App",
          },
        }
      );

      if (!publicKeyResponse.ok) {
        // Log full error for debugging but don't expose to client
        const errorDetails = await publicKeyResponse.text();
        console.error(
          `[github-secrets] Failed to get public key: ${publicKeyResponse.status}`,
          errorDetails
        );
        // Clean up the API key we created
        try {
          await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
        } catch (deleteError) {
          // CRITICAL: Orphaned API key - key exists in DB but no corresponding GitHub secret
          console.error(
            "[github-secrets] ORPHAN_KEY: Failed to delete API key after public key fetch failure. " +
              `keyId=${keyId}, orgId=${organization.id}, org=${organization.providerAccountLogin}`,
            deleteError
          );
        }
        return c.json(
          {
            error: "Failed to get GitHub public key",
            // Only expose status code, not raw error details
            status: publicKeyResponse.status,
          },
          publicKeyResponse.status as 400 | 403 | 404 | 500
        );
      }

      const publicKeyData =
        (await publicKeyResponse.json()) as GitHubPublicKeyResponse;

      // Step 2: Encrypt the API key using GitHub's public key
      const encryptedValue = await encryptSecretForGitHub(
        apiKey,
        publicKeyData.key
      );

      // Step 3: Create/update the org secret
      const secretBody: Record<string, unknown> = {
        encrypted_value: encryptedValue,
        key_id: publicKeyData.key_id,
        visibility,
      };

      if (visibility === "selected" && body.repository_ids) {
        secretBody.selected_repository_ids = body.repository_ids;
      }

      const createSecretResponse = await fetch(
        `${GITHUB_API}/orgs/${organization.providerAccountLogin}/actions/secrets/${secretName}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Detent-App",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(secretBody),
        }
      );

      if (!createSecretResponse.ok) {
        // Log full error for debugging but don't expose to client
        const errorDetails = await createSecretResponse.text();
        console.error(
          `[github-secrets] Failed to create secret: ${createSecretResponse.status}`,
          errorDetails
        );
        // Clean up the API key we created
        try {
          await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
        } catch (deleteError) {
          // CRITICAL: Orphaned API key - key exists in DB but no corresponding GitHub secret
          console.error(
            "[github-secrets] ORPHAN_KEY: Failed to delete API key after secret creation failure. " +
              `keyId=${keyId}, orgId=${organization.id}, org=${organization.providerAccountLogin}, secretName=${secretName}`,
            deleteError
          );
        }
        return c.json(
          {
            error: "Failed to create GitHub secret",
            // Only expose status code, not raw error details
            status: createSecretResponse.status,
          },
          createSecretResponse.status as 400 | 403 | 404 | 500
        );
      }

      console.log(
        `[github-secrets] Injected ${secretName} into ${organization.providerAccountLogin}`
      );

      return c.json({
        success: true,
        secret_name: secretName,
        visibility,
        api_key_id: keyId,
      });
    } finally {
      await client.end();
    }
  }
);

export default app;
