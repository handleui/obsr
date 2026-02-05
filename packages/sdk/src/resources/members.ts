/**
 * Members Resource
 *
 * Organization member operations.
 */

import type { DetentClient } from "../client.js";
import type {
  LeaveOrganizationResponse,
  OrganizationMembersResponse,
} from "../types.js";

export class MembersResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** List members in an organization */
  async list(organizationId: string): Promise<OrganizationMembersResponse> {
    // Validate parameter
    if (!organizationId || typeof organizationId !== "string" || organizationId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }

    return this.#client.request<OrganizationMembersResponse>(
      `/v1/organization-members/${encodeURIComponent(organizationId)}/members`
    );
  }

  /** Leave an organization */
  async leave(organizationId: string): Promise<LeaveOrganizationResponse> {
    // Validate parameter
    if (!organizationId || typeof organizationId !== "string" || organizationId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }

    return this.#client.request<LeaveOrganizationResponse>(
      "/v1/organization-members/leave",
      {
        method: "POST",
        body: { organization_id: organizationId },
      }
    );
  }
}
