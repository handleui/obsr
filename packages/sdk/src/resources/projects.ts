/**
 * Projects Resource
 *
 * Project management operations.
 */

import type { DetentClient } from "../client.js";
import type {
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
    // Validate parameter
    if (!organizationId || typeof organizationId !== "string" || organizationId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }

    return this.#client.request<ListProjectsResponse>(
      `/v1/projects?organization_id=${encodeURIComponent(organizationId)}`
    );
  }

  /** Get project by ID */
  async get(projectId: string): Promise<ProjectDetailsResponse> {
    // Validate parameter
    if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
      throw new Error("Project ID must be a non-empty string");
    }

    return this.#client.request<ProjectDetailsResponse>(
      `/v1/projects/${encodeURIComponent(projectId)}`
    );
  }

  /** Lookup project by repository full name (e.g., "owner/repo") */
  async lookup(repoFullName: string): Promise<ProjectDetailsResponse> {
    // Validate parameter
    if (!repoFullName || typeof repoFullName !== "string" || repoFullName.trim() === "") {
      throw new Error("Repository name must be a non-empty string (format: owner/repo)");
    }

    return this.#client.request<ProjectDetailsResponse>(
      `/v1/projects/lookup?repo=${encodeURIComponent(repoFullName)}`
    );
  }
}
