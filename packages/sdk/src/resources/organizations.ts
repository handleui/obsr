import type { DetentClient } from "../client.js";
import type {
  DeleteOrganizationResponse,
  OrganizationStatusDetail,
} from "../types.js";

const validateOrgId = (orgId: string): void => {
  if (!orgId || typeof orgId !== "string" || orgId.trim() === "") {
    throw new Error("Organization ID must be a non-empty string");
  }
};

export class OrganizationsResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** Get organization status including settings, project count, and sync state */
  async getStatus(
    organizationId: string
  ): Promise<OrganizationStatusDetail> {
    validateOrgId(organizationId);
    return this.#client.request<OrganizationStatusDetail>(
      `/v1/organizations/${encodeURIComponent(organizationId)}/status`
    );
  }

  /** Delete an organization */
  async delete(
    organizationId: string
  ): Promise<DeleteOrganizationResponse> {
    validateOrgId(organizationId);
    return this.#client.request<DeleteOrganizationResponse>(
      `/v1/organizations/${encodeURIComponent(organizationId)}`,
      { method: "DELETE" }
    );
  }
}
