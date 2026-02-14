import type { DetentClient } from "../client.js";
import type {
  ApiKeysResponse,
  CreateApiKeyResponse,
  DeleteApiKeyResponse,
} from "../types.js";

const validateOrgId = (orgId: string): void => {
  if (!orgId || typeof orgId !== "string" || orgId.trim() === "") {
    throw new Error("Organization ID must be a non-empty string");
  }
};

export class ApiKeysResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** List all API keys for the organization (keys are redacted) */
  async list(organizationId: string): Promise<ApiKeysResponse> {
    validateOrgId(organizationId);
    return this.#client.request<ApiKeysResponse>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/api-keys`
    );
  }

  /** Create a new API key. The full key is only returned on creation. */
  async create(
    organizationId: string,
    name: string
  ): Promise<CreateApiKeyResponse> {
    validateOrgId(organizationId);
    if (!name || typeof name !== "string" || name.trim() === "") {
      throw new Error("Name must be a non-empty string");
    }
    return this.#client.request<CreateApiKeyResponse>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/api-keys`,
      { method: "POST", body: { name } }
    );
  }

  /** Revoke an API key */
  async revoke(
    organizationId: string,
    keyId: string
  ): Promise<DeleteApiKeyResponse> {
    validateOrgId(organizationId);
    if (!keyId || typeof keyId !== "string" || keyId.trim() === "") {
      throw new Error("Key ID must be a non-empty string");
    }
    return this.#client.request<DeleteApiKeyResponse>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/api-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE" }
    );
  }
}
