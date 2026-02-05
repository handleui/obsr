/**
 * Invitations Resource
 *
 * Organization invitation operations.
 */

import type { DetentClient } from "../client.js";
import type {
  CreateInvitationResponse,
  InvitationRole,
  InvitationsResponse,
  RevokeInvitationResponse,
} from "../types.js";

export class InvitationsResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** List pending invitations for an organization */
  async list(organizationId: string): Promise<InvitationsResponse> {
    // Validate parameter
    if (!organizationId || typeof organizationId !== "string" || organizationId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }

    return this.#client.request<InvitationsResponse>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/invitations`
    );
  }

  /** Create an invitation */
  async create(
    organizationId: string,
    email: string,
    role: InvitationRole
  ): Promise<CreateInvitationResponse> {
    // Validate parameters
    if (!organizationId || typeof organizationId !== "string" || organizationId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }
    if (!email || typeof email !== "string" || email.trim() === "") {
      throw new Error("Email must be a non-empty string");
    }
    // Basic email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Email must be a valid email address");
    }
    if (!role || typeof role !== "string" || ["admin", "member", "visitor"].indexOf(role) === -1) {
      throw new Error("Role must be one of: admin, member, visitor");
    }

    return this.#client.request<CreateInvitationResponse>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/invitations`,
      {
        method: "POST",
        body: { email, role },
      }
    );
  }

  /** Revoke an invitation */
  async revoke(
    organizationId: string,
    invitationId: string
  ): Promise<RevokeInvitationResponse> {
    // Validate parameters
    if (!organizationId || typeof organizationId !== "string" || organizationId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }
    if (!invitationId || typeof invitationId !== "string" || invitationId.trim() === "") {
      throw new Error("Invitation ID must be a non-empty string");
    }

    return this.#client.request<RevokeInvitationResponse>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" }
    );
  }
}
