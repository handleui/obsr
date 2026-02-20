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

  /** List heals for a project PR */
  async list(projectId: string, prNumber: number): Promise<HealsResponse> {
    // Validate parameters
    if (!projectId || projectId.trim() === "") {
      throw new Error("Project ID must be a non-empty string");
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error("PR number must be a positive integer");
    }

    return this.#client.request<HealsResponse>(
      `/v1/heal?projectId=${encodeURIComponent(projectId)}&prNumber=${prNumber}`
    );
  }

  /** Get pending heals for a project */
  async pending(projectId: string): Promise<HealsResponse> {
    // Validate parameter
    if (!projectId || projectId.trim() === "") {
      throw new Error("Project ID must be a non-empty string");
    }

    return this.#client.request<HealsResponse>(
      `/v1/heal/pending?projectId=${encodeURIComponent(projectId)}`
    );
  }

  /** Get heal details by ID */
  async get(healId: string): Promise<HealDetailsResponse> {
    // Validate parameter
    if (!healId || healId.trim() === "") {
      throw new Error("Heal ID must be a non-empty string");
    }

    return this.#client.request<HealDetailsResponse>(
      `/v1/heal/${encodeURIComponent(healId)}`
    );
  }

  /** Trigger healing for a PR */
  async trigger(
    projectId: string,
    prNumber: number,
    type?: "autofix" | "heal"
  ): Promise<TriggerHealResponse> {
    // Validate parameters
    if (!projectId || projectId.trim() === "") {
      throw new Error("Project ID must be a non-empty string");
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error("PR number must be a positive integer");
    }

    return this.#client.request<TriggerHealResponse>("/v1/heal/trigger", {
      method: "POST",
      body: { projectId, prNumber, type: type ?? "autofix" },
    });
  }

  /** Trigger healing for a specific heal ID */
  async triggerById(healId: string): Promise<TriggerHealResponse> {
    // Validate parameter
    if (!healId || healId.trim() === "") {
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
    if (!healId || healId.trim() === "") {
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
    if (!healId || healId.trim() === "") {
      throw new Error("Heal ID must be a non-empty string");
    }
    if (reason !== undefined && reason.trim() === "") {
      throw new Error("Reason must be a non-empty string if provided");
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
