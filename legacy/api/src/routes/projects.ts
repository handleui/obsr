/**
 * Projects API routes
 *
 * Manages project registration - linking repositories to organizations.
 * Projects are created when users run `detent link` in their repo.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { getDbClient } from "../db/client";
import { verifyOrgAccess } from "../lib/org-access";
import { validateHandle, validateSlug } from "../lib/validation";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

interface OrganizationDoc {
  _id: string;
  name: string;
  slug: string;
  provider: "github" | "gitlab";
  providerAccountLogin: string;
  providerAccountId: string;
  providerAccountType: "organization" | "user";
  providerInstallationId?: string;
  installerGithubId?: string;
  suspendedAt?: number;
  deletedAt?: number;
}

interface ProjectDoc {
  _id: string;
  organizationId: string;
  handle: string;
  providerRepoId: string;
  providerRepoName: string;
  providerRepoFullName: string;
  providerDefaultBranch?: string;
  isPrivate: boolean;
  removedAt?: number;
  createdAt: number;
}

interface CreateProjectBody {
  organization_id: string;
  provider_repo_id: string;
  provider_repo_name: string;
  provider_repo_full_name: string;
  provider_default_branch?: string;
  is_private?: boolean;
  handle?: string;
}

const parseCreateProjectBody = async (
  c: Context<{ Bindings: Env }>
): Promise<CreateProjectBody | Response> => {
  const body = await c.req.json<CreateProjectBody>();

  if (
    !(
      body.organization_id &&
      body.provider_repo_id &&
      body.provider_repo_name &&
      body.provider_repo_full_name
    )
  ) {
    return c.json(
      {
        error:
          "organization_id, provider_repo_id, provider_repo_name, and provider_repo_full_name are required",
      },
      400
    );
  }

  if (body.handle) {
    const handleValidation = validateHandle(body.handle, "handle");
    if (!handleValidation.valid) {
      return c.json({ error: handleValidation.error }, 400);
    }
  }

  return body;
};

const getOrganizationAccessError = (
  org: OrganizationDoc,
  c: Context<{ Bindings: Env }>
): Response | null => {
  if (org.suspendedAt) {
    return c.json({ error: "Organization is suspended" }, 403);
  }

  if (org.deletedAt) {
    return c.json({ error: "Organization has been deleted" }, 404);
  }

  return null;
};

/**
 * POST /
 * Register a project (link a repository to an organization)
 */
app.post("/", async (c) => {
  const auth = c.get("auth");
  const bodyResult = await parseCreateProjectBody(c);
  if (bodyResult instanceof Response) {
    return bodyResult;
  }
  const body = bodyResult;

  const {
    organization_id: organizationId,
    provider_repo_id: providerRepoId,
    provider_repo_name: providerRepoName,
    provider_repo_full_name: providerRepoFullName,
    provider_default_branch: providerDefaultBranch,
    is_private: isPrivate,
    handle: customHandle,
  } = body;

  const dbClient = getDbClient(c.env);

  const org = (await dbClient.query("organizations:getById", {
    id: organizationId,
  })) as OrganizationDoc | null;

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const orgAccessError = getOrganizationAccessError(org, c);
  if (orgAccessError) {
    return orgAccessError;
  }

  // Verify user has access via on-demand GitHub membership check
  const access = await verifyOrgAccess(auth.userId, org, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  // Check if project already exists for this repo in this organization
  const existingProject = (await dbClient.query("projects:getByOrgRepo", {
    organizationId: org._id,
    providerRepoId,
  })) as ProjectDoc | null;

  const requestedHandle =
    customHandle?.toLowerCase() ?? providerRepoName.toLowerCase();

  if (existingProject && !existingProject.removedAt) {
    // Project already exists, return it
    return c.json({
      project_id: existingProject._id,
      organization_id: existingProject.organizationId,
      handle: existingProject.handle,
      provider_repo_id: existingProject.providerRepoId,
      provider_repo_name: existingProject.providerRepoName,
      provider_repo_full_name: existingProject.providerRepoFullName,
      provider_default_branch: existingProject.providerDefaultBranch,
      is_private: existingProject.isPrivate,
      created: false,
    });
  }

  const handleToUse = existingProject?.removedAt
    ? existingProject.handle
    : requestedHandle;
  const handleConflict = (await dbClient.query("projects:getByOrgHandle", {
    organizationId: org._id,
    handle: handleToUse,
  })) as ProjectDoc | null;

  if (
    handleConflict &&
    !handleConflict.removedAt &&
    handleConflict._id !== existingProject?._id
  ) {
    return c.json({ error: "Project handle already in use" }, 409);
  }

  // Create the project
  // Handle defaults to lowercase repo name for URL-friendly routing
  if (existingProject?.removedAt) {
    await dbClient.mutation("projects:reactivate", {
      id: existingProject._id,
      providerRepoName,
      providerRepoFullName,
      providerDefaultBranch: providerDefaultBranch ?? undefined,
      isPrivate: isPrivate ?? false,
      updatedAt: Date.now(),
    });

    return c.json(
      {
        project_id: existingProject._id,
        organization_id: existingProject.organizationId,
        handle: existingProject.handle,
        provider_repo_id: providerRepoId,
        provider_repo_name: providerRepoName,
        provider_repo_full_name: providerRepoFullName,
        provider_default_branch: providerDefaultBranch ?? null,
        is_private: isPrivate ?? false,
        created: true,
      },
      201
    );
  }

  const projectId = (await dbClient.mutation("projects:create", {
    organizationId: org._id,
    handle: handleToUse,
    providerRepoId,
    providerRepoName,
    providerRepoFullName,
    providerDefaultBranch: providerDefaultBranch ?? undefined,
    isPrivate: isPrivate ?? false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })) as string;

  return c.json(
    {
      project_id: projectId,
      organization_id: org._id,
      handle: handleToUse,
      provider_repo_id: providerRepoId,
      provider_repo_name: providerRepoName,
      provider_repo_full_name: providerRepoFullName,
      provider_default_branch: providerDefaultBranch ?? null,
      is_private: isPrivate ?? false,
      created: true,
    },
    201
  );
});

/**
 * GET /
 * List projects for an organization
 */
app.get("/", async (c) => {
  const auth = c.get("auth");
  const organizationId = c.req.query("organization_id");

  if (!organizationId) {
    return c.json({ error: "organization_id is required" }, 400);
  }

  const dbClient = getDbClient(c.env);
  const org = (await dbClient.query("organizations:getById", {
    id: organizationId,
  })) as OrganizationDoc | null;

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Verify user has access via on-demand GitHub membership check
  const access = await verifyOrgAccess(auth.userId, org, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  // Get all active projects for this organization
  const organizationProjects = (await dbClient.query("projects:listByOrg", {
    organizationId: org._id,
  })) as ProjectDoc[];

  const activeProjects = organizationProjects.filter((p) => !p.removedAt);

  return c.json({
    projects: activeProjects.map((p) => ({
      project_id: p._id,
      organization_id: p.organizationId,
      handle: p.handle,
      provider_repo_id: p.providerRepoId,
      provider_repo_name: p.providerRepoName,
      provider_repo_full_name: p.providerRepoFullName,
      provider_default_branch: p.providerDefaultBranch,
      is_private: p.isPrivate,
      created_at: new Date(p.createdAt).toISOString(),
    })),
  });
});

/**
 * GET /lookup
 * Look up a project by repo full name
 * IMPORTANT: This route must be defined BEFORE /:projectId to prevent /lookup being treated as a projectId
 */
app.get("/lookup", async (c) => {
  const auth = c.get("auth");
  const repoFullName = c.req.query("repo");

  if (!repoFullName) {
    return c.json({ error: "repo query parameter is required" }, 400);
  }

  const dbClient = getDbClient(c.env);
  const project = (await dbClient.query("projects:getByRepoFullName", {
    providerRepoFullName: repoFullName,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await dbClient.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Verify user has access via on-demand GitHub membership check
  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  return c.json({
    project_id: project._id,
    organization_id: project.organizationId,
    organization_name: organization.name,
    organization_slug: organization.slug,
    handle: project.handle,
    provider_repo_id: project.providerRepoId,
    provider_repo_name: project.providerRepoName,
    provider_repo_full_name: project.providerRepoFullName,
    provider_default_branch: project.providerDefaultBranch,
    is_private: project.isPrivate,
    created_at: new Date(project.createdAt).toISOString(),
  });
});

/**
 * GET /by-handle
 * Look up a project by organization slug and project handle
 * Enables @-style routing: @gh/handleui/api -> org=gh/handleui&handle=api
 */
app.get("/by-handle", async (c) => {
  const auth = c.get("auth");
  const orgSlug = c.req.query("org");
  const projectHandle = c.req.query("handle");

  if (!(orgSlug && projectHandle)) {
    return c.json(
      { error: "org and handle query parameters are required" },
      400
    );
  }

  // Validate slug and handle format
  const slugValidation = validateSlug(orgSlug, "org");
  if (!slugValidation.valid) {
    return c.json({ error: slugValidation.error }, 400);
  }

  const handleValidation = validateHandle(projectHandle, "handle");
  if (!handleValidation.valid) {
    return c.json({ error: handleValidation.error }, 400);
  }

  const dbClient = getDbClient(c.env);
  const org = (await dbClient.query("organizations:getBySlug", {
    slug: orgSlug,
  })) as OrganizationDoc | null;

  if (!org || org.deletedAt) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Verify user has access via on-demand GitHub membership check
  const access = await verifyOrgAccess(auth.userId, org, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  // Find project by handle
  const project = (await dbClient.query("projects:getByOrgHandle", {
    organizationId: org._id,
    handle: projectHandle.toLowerCase(),
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({
    project_id: project._id,
    organization_id: org._id,
    organization_name: org.name,
    organization_slug: org.slug,
    handle: project.handle,
    provider_repo_id: project.providerRepoId,
    provider_repo_name: project.providerRepoName,
    provider_repo_full_name: project.providerRepoFullName,
    provider_default_branch: project.providerDefaultBranch,
    is_private: project.isPrivate,
    created_at: new Date(project.createdAt).toISOString(),
  });
});

/**
 * GET /:projectId
 * Get a specific project
 */
app.get("/:projectId", async (c) => {
  const auth = c.get("auth");
  const projectId = c.req.param("projectId");

  const dbClient = getDbClient(c.env);
  const project = (await dbClient.query("projects:getById", {
    id: projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await dbClient.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Verify user has access via on-demand GitHub membership check
  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  return c.json({
    project_id: project._id,
    organization_id: project.organizationId,
    organization_name: organization.name,
    organization_slug: organization.slug,
    handle: project.handle,
    provider_repo_id: project.providerRepoId,
    provider_repo_name: project.providerRepoName,
    provider_repo_full_name: project.providerRepoFullName,
    provider_default_branch: project.providerDefaultBranch,
    is_private: project.isPrivate,
    created_at: new Date(project.createdAt).toISOString(),
  });
});

/**
 * DELETE /:projectId
 * Remove a project (soft delete)
 */
app.delete("/:projectId", async (c) => {
  const auth = c.get("auth");
  const projectId = c.req.param("projectId");

  const dbClient = getDbClient(c.env);
  const project = (await dbClient.query("projects:getById", {
    id: projectId,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  const organization = (await dbClient.query("organizations:getById", {
    id: project.organizationId,
  })) as OrganizationDoc | null;

  if (!organization) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Verify user has access via on-demand GitHub membership check
  const access = await verifyOrgAccess(auth.userId, organization, c.env);
  if (!access.allowed) {
    return c.json({ error: access.error }, 403);
  }

  // Only admins and owners can delete projects
  if (access.role === "member") {
    return c.json(
      { error: "Only organization owners and admins can remove projects" },
      403
    );
  }

  // Soft delete the project
  await dbClient.mutation("projects:update", {
    id: projectId,
    removedAt: Date.now(),
    updatedAt: Date.now(),
  });

  return c.json({ success: true });
});

export default app;
