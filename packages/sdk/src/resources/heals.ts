/**
 * Heals Resource
 *
 * AI healing operations.
 */

import type { DetentClient } from "../client.js";
import type {
  ApplyHealResponse,
  HealDetailsResponse,
  HealsResponse,
  RejectHealResponse,
  TriggerHealResponse,
} from "../types.js";

export class HealsResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** List heals for a project */
  async list(projectId: string): Promise<HealsResponse> {
    // Validate parameter
    if (!projectId || typeof projectId !== "string" || projectId.trim() === "") {
      throw new Error("Project ID must be a non-empty string");
    }

    return this.#client.request<HealsResponse>(
      `/v1/heal?project_id=${encodeURIComponent(projectId)}`
    );
  }

  /** Get pending heals */
  async pending(): Promise<HealsResponse> {
    return this.#client.request<HealsResponse>("/v1/heal/pending");
  }

  /** Get heal details by ID */
  async get(healId: string): Promise<HealDetailsResponse> {
    // Validate parameter
    if (!healId || typeof healId !== "string" || healId.trim() === "") {
      throw new Error("Heal ID must be a non-empty string");
    }

    return this.#client.request<HealDetailsResponse>(
      `/v1/heal/${encodeURIComponent(healId)}`
    );
  }

  /** Trigger healing for specific errors */
  async trigger(errorIds: string[]): Promise<TriggerHealResponse> {
    // Validate parameter
    if (!Array.isArray(errorIds) || errorIds.length === 0) {
      throw new Error("Error IDs must be a non-empty array");
    }
    if (!errorIds.every((id) => typeof id === "string" && id.trim() !== "")) {
      throw new Error("All error IDs must be non-empty strings");
    }

    return this.#client.request<TriggerHealResponse>("/v1/heal/trigger", {
      method: "POST",
      body: { error_ids: errorIds },
    });
  }

  /** Trigger healing for a specific heal ID */
  async triggerById(healId: string): Promise<TriggerHealResponse> {
    // Validate parameter
    if (!healId || typeof healId !== "string" || healId.trim() === "") {
      throw new Error("Heal ID must be a non-empty string");
    }

    return this.#client.request<TriggerHealResponse>(
      `/v1/heal/${encodeURIComponent(healId)}/trigger`,
      { method: "POST" }
    );
  }

  /** Apply a completed heal to the PR */
  async apply(healId: string): Promise<ApplyHealResponse> {
    // Validate parameter
    if (!healId || typeof healId !== "string" || healId.trim() === "") {
      throw new Error("Heal ID must be a non-empty string");
    }

    return this.#client.request<ApplyHealResponse>(
      `/v1/heal/${encodeURIComponent(healId)}/apply`,
      { method: "POST" }
    );
  }

  /** Reject a heal */
  async reject(healId: string, reason?: string): Promise<RejectHealResponse> {
    // Validate parameters
    if (!healId || typeof healId !== "string" || healId.trim() === "") {
      throw new Error("Heal ID must be a non-empty string");
    }
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== "string" || reason.trim() === "") {
        throw new Error("Reason must be a non-empty string if provided");
      }
    }

    return this.#client.request<RejectHealResponse>(
      `/v1/heal/${encodeURIComponent(healId)}/reject`,
      {
        method: "POST",
        body: reason ? { reason } : undefined,
      }
    );
  }
}
