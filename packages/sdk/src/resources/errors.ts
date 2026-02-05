/**
 * Errors Resource
 *
 * CI error retrieval operations.
 */

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
    if (!commit || typeof commit !== "string" || commit.trim() === "") {
      throw new Error("Commit SHA must be a non-empty string");
    }
    if (!repository || typeof repository !== "string" || repository.trim() === "") {
      throw new Error("Repository must be a non-empty string (format: owner/repo)");
    }

    return this.#client.request<ErrorsResponse>(
      `/v1/errors?commit=${encodeURIComponent(commit)}&repository=${encodeURIComponent(repository)}`
    );
  }
}
