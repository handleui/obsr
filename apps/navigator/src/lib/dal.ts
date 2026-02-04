import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import {
  getUser as getAuthUser,
  verifySession as verifySessionToken,
  type WorkOSUser,
} from "./auth";
import { COOKIE_NAMES } from "./constants";
import { getConvexClient, toIsoString } from "./convex-client";
import { getWorkOSAccessToken } from "./workos-session";

const PROVIDER_MAP = {
  gh: "github",
  gl: "gitlab",
  github: "github",
  gitlab: "gitlab",
} as const;

type Provider = (typeof PROVIDER_MAP)[keyof typeof PROVIDER_MAP];

const resolveProvider = (provider: string): Provider | null => {
  const resolved = PROVIDER_MAP[provider as keyof typeof PROVIDER_MAP];
  return resolved ?? null;
};

const GITHUB_LOGIN_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const GITLAB_LOGIN_PATTERN =
  /^[a-z\d](?:[a-z\d]|[._-](?=[a-z\d])){0,253}[a-z\d]$|^[a-z\d]{1}$/i;
// Handle pattern: derived from GitHub/GitLab repo names (alphanumeric, hyphens, underscores, dots)
// Must start with alphanumeric, max 100 chars (GitHub repo name limit)
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const isValidProviderLogin = (login: string, provider: Provider): boolean => {
  if (!login || typeof login !== "string") {
    return false;
  }
  if (provider === "github") {
    return GITHUB_LOGIN_PATTERN.test(login);
  }
  if (login.length < 2 || login.length > 255) {
    return false;
  }
  return GITLAB_LOGIN_PATTERN.test(login);
};

const isValidHandle = (handle: string): boolean => {
  if (!handle || typeof handle !== "string") {
    return false;
  }
  const trimmed = handle.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 255) {
    return false;
  }
  return HANDLE_PATTERN.test(trimmed);
};

const isNextRedirect = (error: unknown): boolean =>
  error instanceof Error &&
  "digest" in error &&
  String((error as { digest?: string }).digest).includes("NEXT_REDIRECT");

interface OrganizationDoc {
  _id: Id<"organizations">;
  name: string;
  slug: string;
  provider: Provider;
  providerAccountId: string;
  providerAccountLogin: string;
  providerAccountType: "organization" | "user";
  providerAvatarUrl?: string | null;
  providerInstallationId?: string | null;
  suspendedAt?: number | null;
  deletedAt?: number | null;
  createdAt: number;
}

interface OrganizationMemberDoc {
  role: "owner" | "admin" | "member" | "visitor";
  userId: string;
  removedAt?: number | null;
}

interface ProjectDoc {
  _id: Id<"projects">;
  handle: string;
  providerRepoId: string;
  providerRepoName: string;
  providerRepoFullName: string;
  providerDefaultBranch?: string | null;
  isPrivate: boolean;
  createdAt: number;
  removedAt?: number | null;
}

const getAuthedConvexClient = cache(async () => {
  const accessToken = await getWorkOSAccessToken();
  if (!accessToken) {
    redirect("/login");
  }
  return getConvexClient(accessToken);
});

/**
 * Load organization by provider and login - memoized per request
 * This is the core org lookup used by multiple DAL functions.
 * Using React's cache() prevents redundant Convex queries when
 * layout.tsx makes parallel fetches (fetchOrg, fetchMembership, fetchProject).
 */
const loadOrganization = cache(
  async (provider: Provider, org: string): Promise<OrganizationDoc | null> => {
    const convex = await getAuthedConvexClient();
    const organization = (await convex.query(
      api.organizations.getByProviderAccountLogin,
      {
        provider,
        providerAccountLogin: org,
      }
    )) as OrganizationDoc | null;

    if (!organization || organization.deletedAt) {
      return null;
    }

    return organization;
  }
);

export interface Session {
  userId: string;
  email: string;
  name: string | null;
  token: string;
}

export const verifySession = cache(async (): Promise<Session> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAMES.session)?.value;

  if (!token) {
    redirect("/login");
  }

  const payload = await verifySessionToken(token);

  if (!payload) {
    redirect("/login");
  }

  const user = payload.user as WorkOSUser;

  return {
    userId: user.id,
    email: user.email,
    name:
      user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : user.firstName || user.lastName || null,
    token,
  };
});

export const getUser = cache(async (): Promise<Session | null> => {
  const { isAuthenticated, user } = await getAuthUser();

  if (!(isAuthenticated && user)) {
    return null;
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAMES.session)?.value;

  if (!token) {
    return null;
  }

  return {
    userId: user.id,
    email: user.email,
    name:
      user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : user.firstName || user.lastName || null,
    token,
  };
});

const loadOrgAndMembership = async (
  provider: Provider,
  org: string,
  userId: string
): Promise<{
  organization: OrganizationDoc;
  member: OrganizationMemberDoc;
} | null> => {
  const convex = await getAuthedConvexClient();
  const organization = await loadOrganization(provider, org);
  if (!organization) {
    return null;
  }

  const member = (await convex.query(api.organization_members.getByOrgUser, {
    organizationId: organization._id,
    userId,
  })) as OrganizationMemberDoc | null;

  if (!member || member.removedAt) {
    return null;
  }

  return { organization, member };
};

export interface OrgData {
  id: string;
  slug: string;
  name: string;
  provider: string;
  provider_account_login: string;
  provider_account_type: string;
  provider_avatar_url: string | null;
  app_installed: boolean;
  suspended_at: string | null;
  created_at: string;
}

/**
 * Fetch organization data - cached per request
 * Reduces duplicate fetches across layouts/pages
 */
export const fetchOrg = cache(
  async (provider: string, org: string): Promise<OrgData | null> => {
    try {
      const resolvedProvider = resolveProvider(provider);
      if (!(resolvedProvider && isValidProviderLogin(org, resolvedProvider))) {
        return null;
      }

      const slug = org.toLowerCase();
      const organization = await loadOrganization(resolvedProvider, slug);
      if (!organization) {
        return null;
      }
      return {
        id: organization._id,
        name: organization.name,
        slug: organization.slug,
        provider: organization.provider,
        provider_account_login: organization.providerAccountLogin,
        provider_account_type: organization.providerAccountType,
        provider_avatar_url: organization.providerAvatarUrl ?? null,
        app_installed: Boolean(organization.providerInstallationId),
        suspended_at: toIsoString(organization.suspendedAt),
        created_at: new Date(organization.createdAt).toISOString(),
      };
    } catch (error) {
      if (isNextRedirect(error)) {
        throw error;
      }
      return null;
    }
  }
);

export interface ProjectData {
  id: string;
  handle: string;
  provider_repo_id: string;
  provider_repo_name: string;
  provider_repo_full_name: string;
  provider_default_branch: string | null;
  is_private: boolean;
  created_at: string;
}

/**
 * Fetch project data - cached per request
 */
export const fetchProject = cache(
  async (
    provider: string,
    org: string,
    project: string
  ): Promise<ProjectData | null> => {
    try {
      const resolvedProvider = resolveProvider(provider);
      if (
        !(
          resolvedProvider &&
          isValidProviderLogin(org, resolvedProvider) &&
          isValidHandle(project)
        )
      ) {
        return null;
      }

      const session = await verifySession();
      const slug = org.toLowerCase();
      const handle = project.toLowerCase();
      const result = await loadOrgAndMembership(
        resolvedProvider,
        slug,
        session.userId
      );
      if (!result) {
        return null;
      }

      const convex = await getAuthedConvexClient();
      const record = (await convex.query(api.projects.getByOrgHandle, {
        organizationId: result.organization._id,
        handle,
      })) as ProjectDoc | null;

      if (!record || record.removedAt) {
        return null;
      }

      return {
        id: record._id,
        handle: record.handle,
        provider_repo_id: record.providerRepoId,
        provider_repo_name: record.providerRepoName,
        provider_repo_full_name: record.providerRepoFullName,
        provider_default_branch: record.providerDefaultBranch ?? null,
        is_private: record.isPrivate,
        created_at: new Date(record.createdAt).toISOString(),
      };
    } catch (error) {
      if (isNextRedirect(error)) {
        throw error;
      }
      return null;
    }
  }
);

export interface ProjectsResponse {
  projects: ProjectData[];
}

/**
 * Fetch all projects for an organization - cached per request
 */
export const fetchProjects = cache(
  async (provider: string, org: string): Promise<ProjectsResponse | null> => {
    try {
      const resolvedProvider = resolveProvider(provider);
      if (!(resolvedProvider && isValidProviderLogin(org, resolvedProvider))) {
        return null;
      }

      const session = await verifySession();
      const slug = org.toLowerCase();
      const result = await loadOrgAndMembership(
        resolvedProvider,
        slug,
        session.userId
      );
      if (!result) {
        return null;
      }

      const convex = await getAuthedConvexClient();
      const records = (await convex.query(api.projects.listByOrg, {
        organizationId: result.organization._id,
      })) as unknown as ProjectDoc[];

      const projects = records
        .filter((record) => !record.removedAt)
        .map((record) => ({
          id: record._id,
          handle: record.handle,
          provider_repo_id: record.providerRepoId,
          provider_repo_name: record.providerRepoName,
          provider_repo_full_name: record.providerRepoFullName,
          provider_default_branch: record.providerDefaultBranch ?? null,
          is_private: record.isPrivate,
          created_at: new Date(record.createdAt).toISOString(),
        }));

      return { projects };
    } catch (error) {
      if (isNextRedirect(error)) {
        throw error;
      }
      return null;
    }
  }
);

export interface OrgMembership {
  role: "owner" | "admin" | "member" | "visitor";
  user_id: string;
  organization_id: string;
}

/**
 * Fetch membership info for an organization
 * Returns null if user is not a member (instead of throwing)
 */
export const fetchMembership = cache(
  async (provider: string, org: string): Promise<OrgMembership | null> => {
    try {
      const resolvedProvider = resolveProvider(provider);
      if (!(resolvedProvider && isValidProviderLogin(org, resolvedProvider))) {
        return null;
      }
      const session = await verifySession();
      const slug = org.toLowerCase();
      const organization = await loadOrganization(resolvedProvider, slug);
      if (!organization) {
        return null;
      }

      const convex = await getAuthedConvexClient();
      const member = (await convex.query(
        api.organization_members.getByOrgUser,
        {
          organizationId: organization._id,
          userId: session.userId,
        }
      )) as OrganizationMemberDoc | null;

      if (!member || member.removedAt) {
        return null;
      }

      return {
        role: member.role,
        user_id: member.userId,
        organization_id: organization._id,
      };
    } catch (error) {
      if (isNextRedirect(error)) {
        throw error;
      }
      return null;
    }
  }
);

/**
 * Check if user has admin/owner role for an organization
 * Cached for consistency with other DAL functions
 */
export const isOrgAdmin = cache(
  async (provider: string, org: string): Promise<boolean> => {
    const membership = await fetchMembership(provider, org);
    if (!membership) {
      return false;
    }
    return membership.role === "admin" || membership.role === "owner";
  }
);
