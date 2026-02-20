import type { DetentClient } from "../client.js";
import type { ErrorsResponse } from "../types.js";

export class ErrorsResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** Get errors for a specific commit in a repository */
  async get(commit: string, repository: string): Promise<ErrorsResponse> {
    // Validate parameters
    if (!commit || commit.trim() === "") {
      throw new Error("Commit SHA must be a non-empty string");
    }
    if (!repository || repository.trim() === "") {
      throw new Error("Repository must be a non-empty string (format: owner/repo)");
    }

    return this.#client.request<ErrorsResponse>(
      `/v1/errors?commit=${encodeURIComponent(commit)}&repository=${encodeURIComponent(repository)}`
    );
  }

  /** Get errors for a specific PR in a project */
  async listByPr(projectId: string, prNumber: number): Promise<ErrorsResponse> {
    // Validate parameters
    if (!projectId || projectId.trim() === "") {
      throw new Error("Project ID must be a non-empty string");
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error("PR number must be a positive integer");
    }

    return this.#client.request<ErrorsResponse>(
      `/v1/errors/pr?projectId=${encodeURIComponent(projectId)}&prNumber=${prNumber}`
    );
  }
}
