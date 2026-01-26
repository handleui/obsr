import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import {
  getUser as getAuthUser,
  verifySession as verifySessionToken,
  type WorkOSUser,
} from "./auth";
import { API_BASE_URL, COOKIE_NAMES } from "./constants";

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

export const fetchWithAuth = async (
  path: string,
  options?: RequestInit
): Promise<Response> => {
  const session = await verifySession();

  const url = path.startsWith("/")
    ? `${API_BASE_URL}${path}`
    : `${API_BASE_URL}/${path}`;

  return fetch(url, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${session.token}`,
    },
  });
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
      const response = await fetchWithAuth(`/v1/orgs/${provider}/${org}`);
      if (!response.ok) {
        return null;
      }
      return response.json() as Promise<OrgData>;
    } catch {
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
      const response = await fetchWithAuth(
        `/v1/orgs/${provider}/${org}/projects/${project}`
      );
      if (!response.ok) {
        return null;
      }
      return response.json() as Promise<ProjectData>;
    } catch {
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
      const response = await fetchWithAuth(
        `/v1/orgs/${provider}/${org}/projects`
      );
      if (!response.ok) {
        return null;
      }
      return response.json() as Promise<ProjectsResponse>;
    } catch {
      return null;
    }
  }
);

export interface OrgMembership {
  role: "owner" | "admin" | "member";
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
      const response = await fetchWithAuth(
        `/v1/orgs/${provider}/${org}/membership`
      );

      if (!response.ok) {
        return null;
      }

      return response.json() as Promise<OrgMembership>;
    } catch {
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
