import type { DetentClient } from "../client.js";
import type {
  CreateApiKeyResponse,
  ListApiKeysResponse,
  RevokeApiKeyResponse,
} from "../types.js";

export class ApiKeysResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** Create a new API key for an organization. The full key is returned only on creation. */
  async create(orgId: string, name: string): Promise<CreateApiKeyResponse> {
    if (!orgId || orgId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }
    if (!name || name.trim() === "") {
      throw new Error("Name must be a non-empty string");
    }
    if (name.length > 128) {
      throw new Error("Name must be 128 characters or fewer");
    }
    return this.#client.request<CreateApiKeyResponse>(
      `/v1/orgs/${encodeURIComponent(orgId)}/api-keys`,
      { method: "POST", body: { name: name.trim() } }
    );
  }

  /** List all API keys for an organization (key values are never returned). */
  async list(orgId: string): Promise<ListApiKeysResponse> {
    if (!orgId || orgId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }
    return this.#client.request<ListApiKeysResponse>(
      `/v1/orgs/${encodeURIComponent(orgId)}/api-keys`
    );
  }

  /** Revoke an API key by ID. */
  async revoke(orgId: string, keyId: string): Promise<RevokeApiKeyResponse> {
    if (!orgId || orgId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }
    if (!keyId || keyId.trim() === "") {
      throw new Error("Key ID must be a non-empty string");
    }
    return this.#client.request<RevokeApiKeyResponse>(
      `/v1/orgs/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE" }
    );
  }
}
