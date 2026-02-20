/**
 * Webhooks Resource
 *
 * Webhook management operations.
 */

import type { DetentClient } from "../client.js";
import type {
  CreateWebhookRequest,
  CreateWebhookResponse,
  DeleteWebhookResponse,
  UpdateWebhookRequest,
  WebhookResponse,
  WebhooksResponse,
} from "../types.js";

export class WebhooksResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** Create a webhook for an organization */
  async create(
    orgId: string,
    data: CreateWebhookRequest
  ): Promise<CreateWebhookResponse> {
    if (!orgId || orgId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }
    if (!data.url || data.url.trim() === "") {
      throw new Error("URL must be a non-empty string");
    }
    if (!data.name || data.name.trim() === "") {
      throw new Error("Name must be a non-empty string");
    }
    if (!data.events || data.events.length === 0) {
      throw new Error("At least one event is required");
    }

    return this.#client.request<CreateWebhookResponse>(
      `/v1/orgs/${encodeURIComponent(orgId)}/webhooks`,
      { method: "POST", body: data }
    );
  }

  /** List webhooks for an organization */
  async list(orgId: string): Promise<WebhooksResponse> {
    if (!orgId || orgId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }

    return this.#client.request<WebhooksResponse>(
      `/v1/orgs/${encodeURIComponent(orgId)}/webhooks`
    );
  }

  /** Get a webhook by ID */
  async get(orgId: string, webhookId: string): Promise<WebhookResponse> {
    if (!orgId || orgId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }
    if (!webhookId || webhookId.trim() === "") {
      throw new Error("Webhook ID must be a non-empty string");
    }

    return this.#client.request<WebhookResponse>(
      `/v1/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(webhookId)}`
    );
  }

  /** Update a webhook */
  async update(
    orgId: string,
    webhookId: string,
    data: UpdateWebhookRequest
  ): Promise<WebhookResponse> {
    if (!orgId || orgId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }
    if (!webhookId || webhookId.trim() === "") {
      throw new Error("Webhook ID must be a non-empty string");
    }

    return this.#client.request<WebhookResponse>(
      `/v1/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(webhookId)}`,
      { method: "PATCH", body: data }
    );
  }

  /** Delete a webhook */
  async delete(
    orgId: string,
    webhookId: string
  ): Promise<DeleteWebhookResponse> {
    if (!orgId || orgId.trim() === "") {
      throw new Error("Organization ID must be a non-empty string");
    }
    if (!webhookId || webhookId.trim() === "") {
      throw new Error("Webhook ID must be a non-empty string");
    }

    return this.#client.request<DeleteWebhookResponse>(
      `/v1/orgs/${encodeURIComponent(orgId)}/webhooks/${encodeURIComponent(webhookId)}`,
      { method: "DELETE" }
    );
  }
}
