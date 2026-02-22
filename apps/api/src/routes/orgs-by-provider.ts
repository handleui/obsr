import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getConvexClient } from "../db/convex";
import { validateHandle } from "../lib/validation";
import type { Env } from "../types/env";

const PROVIDER_MAP = {
  gh: "github",
  gl: "gitlab",
} as const;

type ProviderShortcode = keyof typeof PROVIDER_MAP;

const resolveProvider = (shortcode: string): "github" | "gitlab" => {
  const provider = PROVIDER_MAP[shortcode as ProviderShortcode];
  if (!provider) {
    throw new HTTPException(400, { message: "Invalid provider" });
  }
  return provider;
};

// GitHub: alphanumeric + hyphens, 1-39 chars, no start/end hyphen, no consecutive hyphens
const GITHUB_LOGIN_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

// GitLab: alphanumeric + underscores/hyphens/periods, 2-255 chars
// Must start/end with alphanumeric, no consecutive special chars
const GITLAB_LOGIN_PATTERN =
  /^[a-z\d](?:[a-z\d]|[._-](?=[a-z\d])){0,253}[a-z\d]$|^[a-z\d]{1}$/i;

const validateProviderLogin = (
  login: string,
  provider: "github" | "gitlab"
): { valid: boolean; error?: string } => {
  if (!login || typeof login !== "string") {
    return { valid: false, error: "Organization login is required" };
  }

  if (provider === "github") {
    if (!GITHUB_LOGIN_PATTERN.test(login)) {
      return {
        valid: false,
        error: "Invalid GitHub organization login format",
      };
    }
  } else {
    if (login.length < 2 || login.length > 255) {
      return {
        valid: false,
        error: "GitLab login must be between 2 and 255 characters",
      };
    }
    if (!GITLAB_LOGIN_PATTERN.test(login)) {
      return {
        valid: false,
        error: "Invalid GitLab organization login format",
      };
    }
  }

  return { valid: true };
};

interface OrganizationDoc {
  _id: string;
  name: string;
  slug: string;
  provider: "github" | "gitlab";
  providerAccountId: string;
  providerAccountLogin: string;
  providerAccountType: "organization" | "user";
  providerAvatarUrl?: string;
  providerInstallationId?: string;
  suspendedAt?: number;
  deletedAt?: number;
  createdAt: number;
}

interface OrganizationMemberDoc {
  role: string;
  userId: string;
  removedAt?: number;
}

interface ProjectDoc {
  _id: string;
  handle: string;
  providerRepoId: string;
  providerRepoName: string;
  providerRepoFullName: string;
  providerDefaultBranch?: string;
  isPrivate: boolean;
  createdAt: number;
  removedAt?: number;
}

const app = new Hono<{ Bindings: Env }>();

/**
 * GET /:provider/:slug
 * Look up an organization by provider and login.
 * Requires membership in the organization.
 */
app.get("/:provider/:slug", async (c) => {
  const auth = c.get("auth");
  const provider = resolveProvider(c.req.param("provider"));
  const slugParam = c.req.param("slug");

  const validation = validateProviderLogin(slugParam, provider);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const slug = slugParam.toLowerCase();

  const convex = getConvexClient(c.env);
  const org = (await convex.query("organizations:getByProviderAccountLogin", {
    provider,
    providerAccountLogin: slug,
  })) as OrganizationDoc | null;

  if (!org || org.deletedAt) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const member = (await convex.query("organization_members:getByOrgUser", {
    organizationId: org._id,
    userId: auth.userId,
  })) as OrganizationMemberDoc | null;

  if (!member || member.removedAt) {
    return c.json({ error: "Not a member of this organization" }, 403);
  }

  return c.json({
    id: org._id,
    name: org.name,
    slug: org.slug,
    provider: org.provider,
    provider_account_login: org.providerAccountLogin,
    provider_account_type: org.providerAccountType,
    provider_avatar_url: org.providerAvatarUrl,
    app_installed: Boolean(org.providerInstallationId),
    suspended_at: org.suspendedAt
      ? new Date(org.suspendedAt).toISOString()
      : null,
    created_at: new Date(org.createdAt).toISOString(),
  });
});

/**
 * GET /:provider/:slug/membership
 * Check the authenticated user's membership in an organization.
 * Returns 403 if not a member (org exists but access denied).
 */
app.get("/:provider/:slug/membership", async (c) => {
  const auth = c.get("auth");
  const provider = resolveProvider(c.req.param("provider"));
  const slugParam = c.req.param("slug");

  const validation = validateProviderLogin(slugParam, provider);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const slug = slugParam.toLowerCase();

  const convex = getConvexClient(c.env);
  const org = (await convex.query("organizations:getByProviderAccountLogin", {
    provider,
    providerAccountLogin: slug,
  })) as OrganizationDoc | null;

  if (!org || org.deletedAt) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const member = (await convex.query("organization_members:getByOrgUser", {
    organizationId: org._id,
    userId: auth.userId,
  })) as OrganizationMemberDoc | null;

  if (!member || member.removedAt) {
    return c.json({ error: "Not a member of this organization" }, 403);
  }

  return c.json({
    role: member.role,
    user_id: member.userId,
    organization_id: org._id,
  });
});

/**
 * GET /:provider/:slug/projects
 * List all projects for an organization.
 * Requires membership in the organization.
 */
app.get("/:provider/:slug/projects", async (c) => {
  const auth = c.get("auth");
  const provider = resolveProvider(c.req.param("provider"));
  const slugParam = c.req.param("slug");

  const validation = validateProviderLogin(slugParam, provider);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const slug = slugParam.toLowerCase();

  const convex = getConvexClient(c.env);
  const org = (await convex.query("organizations:getByProviderAccountLogin", {
    provider,
    providerAccountLogin: slug,
  })) as OrganizationDoc | null;

  if (!org || org.deletedAt) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const member = (await convex.query("organization_members:getByOrgUser", {
    organizationId: org._id,
    userId: auth.userId,
  })) as OrganizationMemberDoc | null;

  if (!member || member.removedAt) {
    return c.json({ error: "Not a member of this organization" }, 403);
  }

  const orgProjects = (await convex.query("projects:listByOrg", {
    organizationId: org._id,
  })) as ProjectDoc[];

  const activeProjects = orgProjects.filter((project) => !project.removedAt);

  return c.json({
    projects: activeProjects.map((p) => ({
      id: p._id,
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
 * GET /:provider/:slug/projects/:handle
 * Get a specific project by handle.
 * Requires membership in the organization.
 */
app.get("/:provider/:slug/projects/:handle", async (c) => {
  const auth = c.get("auth");
  const provider = resolveProvider(c.req.param("provider"));
  const slugParam = c.req.param("slug");
  const handleParam = c.req.param("handle");

  const slugValidation = validateProviderLogin(slugParam, provider);
  if (!slugValidation.valid) {
    return c.json({ error: slugValidation.error }, 400);
  }

  const handleValidation = validateHandle(handleParam);
  if (!handleValidation.valid) {
    return c.json({ error: handleValidation.error }, 400);
  }

  const slug = slugParam.toLowerCase();
  const handle = handleParam.toLowerCase();

  const convex = getConvexClient(c.env);
  const org = (await convex.query("organizations:getByProviderAccountLogin", {
    provider,
    providerAccountLogin: slug,
  })) as OrganizationDoc | null;

  if (!org || org.deletedAt) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const member = (await convex.query("organization_members:getByOrgUser", {
    organizationId: org._id,
    userId: auth.userId,
  })) as OrganizationMemberDoc | null;

  if (!member || member.removedAt) {
    return c.json({ error: "Not a member of this organization" }, 403);
  }

  const project = (await convex.query("projects:getByOrgHandle", {
    organizationId: org._id,
    handle,
  })) as ProjectDoc | null;

  if (!project || project.removedAt) {
    return c.json({ error: "Project not found" }, 404);
  }

  return c.json({
    id: project._id,
    handle: project.handle,
    provider_repo_id: project.providerRepoId,
    provider_repo_name: project.providerRepoName,
    provider_repo_full_name: project.providerRepoFullName,
    provider_default_branch: project.providerDefaultBranch,
    is_private: project.isPrivate,
    created_at: new Date(project.createdAt).toISOString(),
  });
});

export default app;
