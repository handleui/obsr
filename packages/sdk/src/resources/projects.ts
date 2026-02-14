/**
 * Projects Resource
 *
 * Project management operations.
 */

import type { DetentClient } from "../client.js";
import type {
  CreateProjectRequest,
  CreateProjectResponse,
  DeleteProjectResponse,
  ListProjectsResponse,
  ProjectDetailsResponse,
} from "../types.js";

export class ProjectsResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** List projects for an organization */
  async list(organizationId: string): Promise<ListProjectsResponse> {
    if (
      !organizationId ||
      typeof organizationId !== "string" ||
      organizationId.trim() === ""
    ) {
      throw new Error("Organization ID must be a non-empty string");
    }

    return this.#client.request<ListProjectsResponse>(
      `/v1/projects?organization_id=${encodeURIComponent(organizationId)}`
    );
  }

  /** Get project by ID */
  async get(projectId: string): Promise<ProjectDetailsResponse> {
    if (
      !projectId ||
      typeof projectId !== "string" ||
      projectId.trim() === ""
    ) {
      throw new Error("Project ID must be a non-empty string");
    }

    return this.#client.request<ProjectDetailsResponse>(
      `/v1/projects/${encodeURIComponent(projectId)}`
    );
  }

  /** Lookup project by repository full name (e.g., "owner/repo") */
  async lookup(repoFullName: string): Promise<ProjectDetailsResponse> {
    if (
      !repoFullName ||
      typeof repoFullName !== "string" ||
      repoFullName.trim() === ""
    ) {
      throw new Error(
        "Repository name must be a non-empty string (format: owner/repo)"
      );
    }

    return this.#client.request<ProjectDetailsResponse>(
      `/v1/projects/lookup?repo=${encodeURIComponent(repoFullName)}`
    );
  }

  /** Lookup project by organization slug and project handle */
  async getByHandle(
    orgSlug: string,
    handle: string
  ): Promise<ProjectDetailsResponse> {
    if (!orgSlug || typeof orgSlug !== "string" || orgSlug.trim() === "") {
      throw new Error("Organization slug must be a non-empty string");
    }
    if (!handle || typeof handle !== "string" || handle.trim() === "") {
      throw new Error("Project handle must be a non-empty string");
    }

    return this.#client.request<ProjectDetailsResponse>(
      `/v1/projects/by-handle?org=${encodeURIComponent(orgSlug)}&handle=${encodeURIComponent(handle)}`
    );
  }

  /** Register a project (link a repository to an organization) */
  async create(request: CreateProjectRequest): Promise<CreateProjectResponse> {
    if (
      !request.organization_id ||
      !request.provider_repo_id ||
      !request.provider_repo_name ||
      !request.provider_repo_full_name
    ) {
      throw new Error(
        "organization_id, provider_repo_id, provider_repo_name, and provider_repo_full_name are required"
      );
    }

    return this.#client.request<CreateProjectResponse>("/v1/projects", {
      method: "POST",
      body: request,
    });
  }

  /** Remove a project (soft delete) */
  async delete(projectId: string): Promise<DeleteProjectResponse> {
    if (
      !projectId ||
      typeof projectId !== "string" ||
      projectId.trim() === ""
    ) {
      throw new Error("Project ID must be a non-empty string");
    }

    return this.#client.request<DeleteProjectResponse>(
      `/v1/projects/${encodeURIComponent(projectId)}`,
      { method: "DELETE" }
    );
  }
}
