/**
 * GitHub Secrets Management
 *
 * Injects DETENT_TOKEN as a secret in GitHub (org-level or repo-level).
 * This enables the Detent GitHub Action to authenticate with the API.
 *
 * - Organizations: Creates org-level secret (accessible to all/private/selected repos)
 * - Personal accounts: Must use repo-level secrets via separate endpoint
 */

import { Hono } from "hono";
import { getConvexClient } from "../db/convex";
import { generateApiKey, hashApiKey } from "../lib/crypto";
import { encryptSecretForGitHub } from "../lib/github-crypto";
import {
  getOrgPublicKey,
  putOrgSecret,
  SECRET_NAME_PATTERN,
} from "../lib/github-secrets-helper";
import {
  githubOrgAccessMiddleware,
  type OrgAccessContext,
  requireRole,
} from "../middleware/github-org-access";
import { createGitHubService } from "../services/github";
import type { Env } from "../types/env";

/**
 * Classify error for HTTP response.
 * Returns appropriate status code and client-safe message.
 */
const classifySecretCreationError = (
  error: unknown
): { statusCode: 500 | 502 | 503; message: string } => {
  const errorMessage = error instanceof Error ? error.message : "";

  if (
    errorMessage.includes("GitHub API") ||
    errorMessage.includes("api.github.com")
  ) {
    return { statusCode: 502, message: "GitHub API request failed" };
  }

  if (
    errorMessage.includes("rate limit") ||
    errorMessage.includes("timeout") ||
    errorMessage.includes("ETIMEDOUT") ||
    errorMessage.includes("ECONNRESET")
  ) {
    return {
      statusCode: 503,
      message: "Service temporarily unavailable, please retry",
    };
  }

  return { statusCode: 500, message: "Failed to create GitHub secret" };
};

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

    const convex = getConvexClient(c.env);
    let keyId: string | undefined;

    try {
      // Create a new API key for this injection
      const apiKey = generateApiKey();
      const keyHash = await hashApiKey(apiKey);
      const keyPrefix = apiKey.substring(0, 8); // "dtk_XXXX"

      keyId = (await convex.mutation("api_keys:create", {
        organizationId: organization._id,
        keyHash,
        keyPrefix,
        name: `GitHub Actions (${secretName})`,
        createdAt: Date.now(),
      })) as string;

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
          await convex.mutation("api_keys:remove", { id: keyId });
        } catch (deleteError) {
          // CRITICAL: Orphaned API key - key exists in DB but no corresponding GitHub secret
          console.error(
            `[github-secrets] ORPHAN_KEY: Failed to delete API key after error. keyId=${keyId}, orgId=${organization._id}`,
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

      // Classify error for appropriate HTTP status code
      const { statusCode, message } = classifySecretCreationError(error);
      return c.json({ error: message }, statusCode);
    }
  }
);

export default app;
