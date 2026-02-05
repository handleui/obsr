/**
 * Organizations Resource
 *
 * Organization management operations.
 */

import type { DetentClient } from "../client.js";
import type { DeleteOrganizationResponse } from "../types.js";

export interface OrganizationStatusResponse {
  organization_id: string;
  github_synced: boolean;
  last_sync_at: string | null;
}

export class OrganizationsResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** Get organization GitHub sync status */
  async getStatus(organizationId: string): Promise<OrganizationStatusResponse> {
    // Validate parameter
    if (!organizationId || typeof organizationId !== "string" || organizationId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }

    return this.#client.request<OrganizationStatusResponse>(
      `/v1/organizations/${encodeURIComponent(organizationId)}/status`
    );
  }

  /** Delete an organization */
  async delete(organizationId: string): Promise<DeleteOrganizationResponse> {
    // Validate parameter
    if (!organizationId || typeof organizationId !== "string" || organizationId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }

    return this.#client.request<DeleteOrganizationResponse>(
      `/v1/organizations/${encodeURIComponent(organizationId)}`,
      { method: "DELETE" }
    );
  }
}
