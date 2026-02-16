import { getConvexClient } from "../../../db/convex";
import { createProviderSlug } from "../../../lib/org-settings";
import { captureWebhookError } from "../../../lib/sentry";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type {
  InstallationTargetPayload,
  OrganizationPayload,
  RepositoryPayload,
  WebhookContext,
} from "../types";

// Handle repository events (renamed, transferred, visibility changed)
export const handleRepositoryEvent = async (
  c: WebhookContext,
  payload: RepositoryPayload
) => {
  const { action, repository, installation } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // Only process if we have an installation ID (app is installed)
  if (!installation?.id) {
    return c.json({ message: "ignored", reason: "no installation" });
  }

  console.log(
    `[repository] ${action}: ${repository.full_name} (repo ID: ${repository.id}) [delivery: ${deliveryId}]`
  );

  const convex = getConvexClient(c.env);

  try {
    const orgs = (await convex.query(
      "organizations:listByProviderInstallationId",
      {
        providerInstallationId: String(installation.id),
      }
    )) as Array<{
      _id: string;
      slug: string;
      deletedAt?: number | null;
    }>;
    const org = orgs.find((item) => !item.deletedAt) ?? null;

    if (!org) {
      console.log(
        `[repository] Organization not found for installation ${installation.id}, skipping`
      );
      return c.json({
        message: "organization not found",
        installation_id: installation.id,
      });
    }

    // Resolve project in installation scope first to avoid cross-org ambiguity.
    let project = (await convex.query("projects:getByOrgRepo", {
      organizationId: org._id,
      providerRepoId: String(repository.id),
    })) as {
      _id: string;
      organizationId: string;
      handle: string;
      providerRepoName: string;
      providerRepoFullName: string;
      isPrivate: boolean;
    } | null;

    // Fallback for legacy rows created before scoped lookup.
    if (!project) {
      project = (await convex.query("projects:getByRepoId", {
        providerRepoId: String(repository.id),
      })) as {
        _id: string;
        organizationId: string;
        handle: string;
        providerRepoName: string;
        providerRepoFullName: string;
        isPrivate: boolean;
      } | null;
    }

    if (!project) {
      // Ensure repository events can self-heal missing project rows.
      await convex.mutation("projects:syncFromGitHub", {
        organizationId: org._id,
        repos: [
          {
            id: String(repository.id),
            name: repository.name,
            fullName: repository.full_name,
            defaultBranch: repository.default_branch,
            isPrivate: repository.private,
          },
        ],
        syncRemoved: false,
      });

      project = (await convex.query("projects:getByOrgRepo", {
        organizationId: org._id,
        providerRepoId: String(repository.id),
      })) as {
        _id: string;
        organizationId: string;
        handle: string;
        providerRepoName: string;
        providerRepoFullName: string;
        isPrivate: boolean;
      } | null;

      if (!project) {
        console.log(
          `[repository] Project not found for repo ID ${repository.id}, skipping`
        );
        return c.json({
          message: "project not found",
          repo_id: repository.id,
        });
      }
    }

    switch (action) {
      case "renamed": {
        // Update repo name and full_name, but preserve custom handle
        await convex.mutation("projects:update", {
          id: project._id,
          providerRepoName: repository.name,
          providerRepoFullName: repository.full_name,
          updatedAt: Date.now(),
        });

        console.log(
          `[repository] Updated project ${project._id}: ${project.providerRepoFullName} -> ${repository.full_name}`
        );

        return c.json({
          message: "repository renamed",
          project_id: project._id,
          old_name: project.providerRepoFullName,
          new_name: repository.full_name,
        });
      }

      case "privatized":
      case "publicized": {
        const isPrivate = action === "privatized";
        await convex.mutation("projects:update", {
          id: project._id,
          isPrivate,
          updatedAt: Date.now(),
        });

        console.log(
          `[repository] Updated project ${project._id} visibility: private=${isPrivate}`
        );

        return c.json({
          message: `repository ${action}`,
          project_id: project._id,
          is_private: isPrivate,
        });
      }

      case "transferred": {
        // Move repository to org tied to this installation and update name metadata.
        await convex.mutation("projects:update", {
          id: project._id,
          organizationId: org._id,
          providerRepoName: repository.name,
          providerRepoFullName: repository.full_name,
          isPrivate: repository.private,
          providerDefaultBranch: repository.default_branch,
          updatedAt: Date.now(),
        });

        console.log(
          `[repository] Repository transferred, updated full_name to ${repository.full_name} (org: ${project.organizationId} -> ${org._id})`
        );

        return c.json({
          message: "repository transferred",
          project_id: project._id,
          new_full_name: repository.full_name,
        });
      }

      default:
        return c.json({ message: "ignored", action });
    }
  } catch (error) {
    console.error(
      `[repository] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "repository",
      deliveryId,
      repository: repository.full_name,
      installationId: installation?.id,
    });
    return c.json(
      {
        message: "repository error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        repository: repository.full_name,
      },
      500
    );
  }
};

// Handle organization events (GitHub org renamed, etc.)
export const handleOrganizationEvent = async (
  c: WebhookContext,
  payload: OrganizationPayload
) => {
  const { action, organization, changes, installation } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  // Only process if we have an installation ID (app is installed)
  if (!installation?.id) {
    return c.json({ message: "ignored", reason: "no installation" });
  }

  console.log(
    `[organization] ${action}: ${organization.login} (org ID: ${organization.id}) [delivery: ${deliveryId}]`
  );

  // Handle member changes - invalidate cache and optionally auto-remove
  if (action === "member_added" || action === "member_removed") {
    const { handleOrganizationWebhook } = await import("./organization");
    const result = await handleOrganizationWebhook(payload, c.env, deliveryId);
    return c.json({
      message: `organization ${action}`,
      ...result,
    });
  }

  // Only handle renamed action for DB updates
  if (action !== "renamed") {
    return c.json({ message: "ignored", action });
  }

  const oldLogin = changes?.login?.from;
  if (!oldLogin) {
    console.log("[organization] No login change found in payload, skipping");
    return c.json({ message: "ignored", reason: "no login change" });
  }

  const convex = getConvexClient(c.env);

  try {
    // Find the organization by provider account ID (immutable)
    const org = (await convex.query("organizations:getByProviderAccount", {
      provider: "github",
      providerAccountId: String(organization.id),
    })) as {
      _id: string;
      slug: string;
      providerAccountLogin: string;
    } | null;
    if (!org) {
      console.log(
        `[organization] Organization not found for GitHub org ID ${organization.id}, skipping`
      );
      return c.json({
        message: "organization not found",
        github_org_id: organization.id,
      });
    }

    // Update providerAccountLogin
    const updates: {
      providerAccountLogin: string;
      providerAvatarUrl: string | null;
      updatedAt: number;
      slug?: string;
      name?: string;
    } = {
      providerAccountLogin: organization.login,
      providerAvatarUrl: organization.avatar_url ?? null,
      updatedAt: Date.now(),
    };

    // Check if slug matches the provider pattern (gh/old-login)
    const oldProviderSlug = createProviderSlug("github", oldLogin);
    if (org.slug === oldProviderSlug) {
      // Update slug to match new login
      const newProviderSlug = createProviderSlug("github", organization.login);
      updates.slug = newProviderSlug;
      updates.name = organization.login;
    }

    await convex.mutation("organizations:update", {
      id: org._id,
      ...updates,
    });

    console.log(
      `[organization] Updated organization ${org._id}: login ${oldLogin} -> ${organization.login}${
        updates.slug ? `, slug ${org.slug} -> ${updates.slug}` : ""
      }`
    );

    return c.json({
      message: "organization renamed",
      organization_id: org._id,
      old_login: oldLogin,
      new_login: organization.login,
      old_slug: org.slug,
      new_slug: updates.slug ?? org.slug,
    });
  } catch (error) {
    console.error(
      `[organization] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "organization",
      deliveryId,
      installationId: installation?.id,
    });
    return c.json(
      {
        message: "organization error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        organization: organization.login,
      },
      500
    );
  }
};

// Handle installation_target events (account renamed)
export const handleInstallationTargetEvent = async (
  c: WebhookContext,
  payload: InstallationTargetPayload
) => {
  const { action, installation_target, changes } = payload;
  const deliveryId = c.req.header("X-GitHub-Delivery") ?? "unknown";

  console.log(
    `[installation_target] ${action}: ${installation_target.login} (account ID: ${installation_target.id}) [delivery: ${deliveryId}]`
  );

  if (action !== "renamed") {
    return c.json({ message: "ignored", action });
  }

  const oldLogin = changes?.login?.from;
  if (!oldLogin) {
    console.log(
      "[installation_target] No login change found in payload, skipping"
    );
    return c.json({ message: "ignored", reason: "no login change" });
  }

  const convex = getConvexClient(c.env);

  try {
    const org = (await convex.query("organizations:getByProviderAccount", {
      provider: "github",
      providerAccountId: String(installation_target.id),
    })) as {
      _id: string;
      slug: string;
      providerAccountLogin: string;
    } | null;

    if (!org) {
      console.log(
        `[installation_target] Organization not found for account ID ${installation_target.id}, skipping`
      );
      return c.json({
        message: "organization not found",
        github_account_id: installation_target.id,
      });
    }

    const updates: {
      providerAccountLogin: string;
      providerAvatarUrl: string | null;
      updatedAt: number;
      slug?: string;
      name?: string;
    } = {
      providerAccountLogin: installation_target.login,
      providerAvatarUrl: installation_target.avatar_url ?? null,
      updatedAt: Date.now(),
    };

    const oldProviderSlug = createProviderSlug("github", oldLogin);
    if (org.slug === oldProviderSlug) {
      const newProviderSlug = createProviderSlug(
        "github",
        installation_target.login
      );
      updates.slug = newProviderSlug;
      updates.name = installation_target.login;
    }

    await convex.mutation("organizations:update", {
      id: org._id,
      ...updates,
    });

    console.log(
      `[installation_target] Updated organization ${org._id}: login ${oldLogin} -> ${installation_target.login}${
        updates.slug ? `, slug ${org.slug} -> ${updates.slug}` : ""
      }`
    );

    return c.json({
      message: "installation target renamed",
      organization_id: org._id,
      old_login: oldLogin,
      new_login: installation_target.login,
      old_slug: org.slug,
      new_slug: updates.slug ?? org.slug,
    });
  } catch (error) {
    console.error(
      `[installation_target] Error processing [delivery: ${deliveryId}]:`,
      error
    );
    const classified = classifyError(error);
    captureWebhookError(error, classified.code, {
      eventType: "installation_target",
      deliveryId,
    });
    return c.json(
      {
        message: "installation target error",
        errorCode: classified.code,
        error: classified.message,
        hint: classified.hint,
        deliveryId,
        account: installation_target.login,
      },
      500
    );
  }
};
