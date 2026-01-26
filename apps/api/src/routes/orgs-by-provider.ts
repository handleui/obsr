import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDb } from "../db/client";
import { organizationMembers, organizations, projects } from "../db/schema";
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

// Project handles are internal, use GitHub-style pattern (alphanumeric + hyphens, 1-39 chars)
const validateHandle = (handle: string): { valid: boolean; error?: string } => {
  if (!handle || typeof handle !== "string") {
    return { valid: false, error: "Project handle is required" };
  }
  if (!GITHUB_LOGIN_PATTERN.test(handle)) {
    return { valid: false, error: "Invalid project handle format" };
  }
  return { valid: true };
};

type DbClient = Awaited<ReturnType<typeof createDb>>["db"];

/**
 * Fetch org and membership in a single query using LEFT JOIN
 * Reduces 2 sequential queries to 1 for authorization checks
 */
const getOrgWithMembership = async (
  db: DbClient,
  provider: "github" | "gitlab",
  slug: string,
  userId: string
) => {
  const result = await db
    .select({
      org: organizations,
      member: organizationMembers,
    })
    .from(organizations)
    .leftJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        eq(organizationMembers.userId, userId),
        isNull(organizationMembers.removedAt)
      )
    )
    .where(
      and(
        eq(organizations.provider, provider),
        eq(organizations.providerAccountLogin, slug),
        isNull(organizations.deletedAt)
      )
    )
    .limit(1);

  return result[0] ?? null;
};

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

  const { db, client } = await createDb(c.env);
  try {
    const result = await getOrgWithMembership(db, provider, slug, auth.userId);

    if (!result?.org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (!result.member) {
      return c.json({ error: "Not a member of this organization" }, 403);
    }

    const { org } = result;

    return c.json({
      id: org.id,
      name: org.name,
      slug: org.slug,
      provider: org.provider,
      provider_account_login: org.providerAccountLogin,
      provider_account_type: org.providerAccountType,
      provider_avatar_url: org.providerAvatarUrl,
      app_installed: Boolean(org.providerInstallationId),
      suspended_at: org.suspendedAt?.toISOString() ?? null,
      created_at: org.createdAt.toISOString(),
    });
  } finally {
    await client.end();
  }
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

  const { db, client } = await createDb(c.env);
  try {
    const result = await getOrgWithMembership(db, provider, slug, auth.userId);

    if (!result?.org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (!result.member) {
      return c.json({ error: "Not a member of this organization" }, 403);
    }

    return c.json({
      role: result.member.role,
      user_id: result.member.userId,
      organization_id: result.org.id,
    });
  } finally {
    await client.end();
  }
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

  const { db, client } = await createDb(c.env);
  try {
    const result = await getOrgWithMembership(db, provider, slug, auth.userId);

    if (!result?.org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (!result.member) {
      return c.json({ error: "Not a member of this organization" }, 403);
    }

    const orgProjects = await db
      .select({
        id: projects.id,
        handle: projects.handle,
        providerRepoId: projects.providerRepoId,
        providerRepoName: projects.providerRepoName,
        providerRepoFullName: projects.providerRepoFullName,
        providerDefaultBranch: projects.providerDefaultBranch,
        isPrivate: projects.isPrivate,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, result.org.id),
          isNull(projects.removedAt)
        )
      );

    return c.json({
      projects: orgProjects.map((p) => ({
        id: p.id,
        handle: p.handle,
        provider_repo_id: p.providerRepoId,
        provider_repo_name: p.providerRepoName,
        provider_repo_full_name: p.providerRepoFullName,
        provider_default_branch: p.providerDefaultBranch,
        is_private: p.isPrivate,
        created_at: p.createdAt.toISOString(),
      })),
    });
  } finally {
    await client.end();
  }
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

  const { db, client } = await createDb(c.env);
  try {
    const result = await getOrgWithMembership(db, provider, slug, auth.userId);

    if (!result?.org) {
      return c.json({ error: "Organization not found" }, 404);
    }

    if (!result.member) {
      return c.json({ error: "Not a member of this organization" }, 403);
    }

    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.organizationId, result.org.id),
        eq(projects.handle, handle),
        isNull(projects.removedAt)
      ),
    });

    if (!project) {
      return c.json({ error: "Project not found" }, 404);
    }

    return c.json({
      id: project.id,
      handle: project.handle,
      provider_repo_id: project.providerRepoId,
      provider_repo_name: project.providerRepoName,
      provider_repo_full_name: project.providerRepoFullName,
      provider_default_branch: project.providerDefaultBranch,
      is_private: project.isPrivate,
      created_at: project.createdAt.toISOString(),
    });
  } finally {
    await client.end();
  }
});

export default app;
