/**
 * Auth Resource
 *
 * Authentication and identity operations.
 */

import type { DetentClient } from "../client.js";
import type {
  GitHubOrgsResponse,
  GitHubTokenRefreshResponse,
  MeResponse,
  OrganizationsResponse,
  SyncIdentityResponse,
} from "../types.js";

export class AuthResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** Get current user identity */
  async me(): Promise<MeResponse> {
    return this.#client.request<MeResponse>("/v1/auth/me");
  }

  /** Sync user identity with GitHub (links GitHub account if token provided) */
  async syncUser(githubToken?: string): Promise<SyncIdentityResponse> {
    // Validate token if provided to prevent invalid credentials from being sent
    if (githubToken !== undefined && githubToken !== null) {
      if (typeof githubToken !== "string" || githubToken.trim() === "") {
        throw new Error("GitHub token must be a non-empty string");
      }
    }

    return this.#client.request<SyncIdentityResponse>("/v1/auth/sync-user", {
      method: "POST",
      ...(githubToken && { headers: { "X-GitHub-Token": githubToken } }),
    });
  }

  /** Get user's organizations */
  async getOrganizations(): Promise<OrganizationsResponse> {
    return this.#client.request<OrganizationsResponse>(
      "/v1/auth/organizations"
    );
  }

  /** Get GitHub organizations available for installation */
  async getGitHubOrgs(githubToken?: string): Promise<GitHubOrgsResponse> {
    // Validate token if provided to prevent invalid credentials from being sent
    if (githubToken !== undefined && githubToken !== null) {
      if (typeof githubToken !== "string" || githubToken.trim() === "") {
        throw new Error("GitHub token must be a non-empty string");
      }
    }

    return this.#client.request<GitHubOrgsResponse>("/v1/auth/github-orgs", {
      ...(githubToken && { headers: { "X-GitHub-Token": githubToken } }),
    });
  }

  /** Refresh GitHub OAuth token */
  async refreshGitHubToken(
    refreshToken: string
  ): Promise<GitHubTokenRefreshResponse> {
    return this.#client.request<GitHubTokenRefreshResponse>(
      "/v1/auth/github-token/refresh",
      {
        method: "POST",
        body: { refresh_token: refreshToken },
      }
    );
  }
}
