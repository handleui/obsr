import { and, eq } from "drizzle-orm";
import { createDb } from "../../../db/client";
import {
  createProviderSlug,
  organizations,
  projects,
} from "../../../db/schema";
import { captureWebhookError } from "../../../lib/sentry";
import { classifyError } from "../../../services/webhooks/error-classifier";
import type {
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

  const { db, client } = await createDb(c.env);

  try {
    // Find the project by provider repo ID
    const existingProject = await db
      .select({
        id: projects.id,
        handle: projects.handle,
        providerRepoName: projects.providerRepoName,
        providerRepoFullName: projects.providerRepoFullName,
        isPrivate: projects.isPrivate,
      })
      .from(projects)
      .where(eq(projects.providerRepoId, String(repository.id)))
      .limit(1);

    const project = existingProject[0];
    if (!project) {
      console.log(
        `[repository] Project not found for repo ID ${repository.id}, skipping`
      );
      return c.json({
        message: "project not found",
        repo_id: repository.id,
      });
    }

    switch (action) {
      case "renamed": {
        // Update repo name and full_name, but preserve custom handle
        await db
          .update(projects)
          .set({
            providerRepoName: repository.name,
            providerRepoFullName: repository.full_name,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, project.id));

        console.log(
          `[repository] Updated project ${project.id}: ${project.providerRepoFullName} -> ${repository.full_name}`
        );

        return c.json({
          message: "repository renamed",
          project_id: project.id,
          old_name: project.providerRepoFullName,
          new_name: repository.full_name,
        });
      }

      case "privatized":
      case "publicized": {
        const isPrivate = action === "privatized";
        await db
          .update(projects)
          .set({
            isPrivate,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, project.id));

        console.log(
          `[repository] Updated project ${project.id} visibility: private=${isPrivate}`
        );

        return c.json({
          message: `repository ${action}`,
          project_id: project.id,
          is_private: isPrivate,
        });
      }

      case "transferred": {
        // Repository was transferred to another owner
        // The project stays with the original org, but we update the full_name
        await db
          .update(projects)
          .set({
            providerRepoFullName: repository.full_name,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, project.id));

        console.log(
          `[repository] Repository transferred, updated full_name to ${repository.full_name}`
        );

        return c.json({
          message: "repository transferred",
          project_id: project.id,
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
  } finally {
    await client.end();
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

  // Only handle renamed action for now
  if (action !== "renamed") {
    return c.json({ message: "ignored", action });
  }

  const oldLogin = changes?.login?.from;
  if (!oldLogin) {
    console.log("[organization] No login change found in payload, skipping");
    return c.json({ message: "ignored", reason: "no login change" });
  }

  const { db, client } = await createDb(c.env);

  try {
    // Find the organization by provider account ID (immutable)
    const existingOrg = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        providerAccountLogin: organizations.providerAccountLogin,
      })
      .from(organizations)
      .where(
        and(
          eq(organizations.provider, "github"),
          eq(organizations.providerAccountId, String(organization.id))
        )
      )
      .limit(1);

    const org = existingOrg[0];
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
      updatedAt: Date;
      slug?: string;
      name?: string;
    } = {
      providerAccountLogin: organization.login,
      providerAvatarUrl: organization.avatar_url ?? null,
      updatedAt: new Date(),
    };

    // Check if slug matches the provider pattern (gh/old-login)
    const oldProviderSlug = createProviderSlug("github", oldLogin);
    if (org.slug === oldProviderSlug) {
      // Update slug to match new login
      const newProviderSlug = createProviderSlug("github", organization.login);
      updates.slug = newProviderSlug;
      updates.name = organization.login;
    }

    await db
      .update(organizations)
      .set(updates)
      .where(eq(organizations.id, org.id));

    console.log(
      `[organization] Updated organization ${org.id}: login ${oldLogin} -> ${organization.login}${
        updates.slug ? `, slug ${org.slug} -> ${updates.slug}` : ""
      }`
    );

    return c.json({
      message: "organization renamed",
      organization_id: org.id,
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
  } finally {
    await client.end();
  }
};
