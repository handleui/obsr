import type { DetentClient } from "../client.js";
import type {
  ApplyHealResponse,
  HealDetailsResponse,
  HealsResponse,
  RejectHealResponse,
  TriggerHealByPrResponse,
  TriggerHealResponse,
} from "../types.js";

const validateId = (id: string, label: string): void => {
  if (!id || typeof id !== "string" || id.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
};

export class HealsResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** List heals for a project + PR */
  async list(projectId: string, prNumber: number): Promise<HealsResponse> {
    validateId(projectId, "Project ID");
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error("PR number must be a positive integer");
    }

    return this.#client.request<HealsResponse>(
      `/v1/heal?projectId=${encodeURIComponent(projectId)}&prNumber=${prNumber}`
    );
  }

  /** Get pending heals for a project */
  async pending(projectId: string): Promise<HealsResponse> {
    validateId(projectId, "Project ID");
    return this.#client.request<HealsResponse>(
      `/v1/heal/pending?projectId=${encodeURIComponent(projectId)}`
    );
  }

  /** Get heal details by ID */
  async get(healId: string): Promise<HealDetailsResponse> {
    validateId(healId, "Heal ID");
    return this.#client.request<HealDetailsResponse>(
      `/v1/heal/${encodeURIComponent(healId)}`
    );
  }

  /** Trigger healing for a specific heal ID (status must be "found") */
  async triggerById(healId: string): Promise<TriggerHealResponse> {
    validateId(healId, "Heal ID");
    return this.#client.request<TriggerHealResponse>(
      `/v1/heal/${encodeURIComponent(healId)}/trigger`,
      { method: "POST" }
    );
  }

  /** Trigger healing for a PR (creates heals from fixable errors) */
  async triggerByPr(
    projectId: string,
    prNumber: number,
    type: "autofix" | "heal" = "autofix"
  ): Promise<TriggerHealByPrResponse> {
    validateId(projectId, "Project ID");
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error("PR number must be a positive integer");
    }
    return this.#client.request<TriggerHealByPrResponse>("/v1/heal/trigger", {
      method: "POST",
      body: { projectId, prNumber, type },
    });
  }

  /** Apply a completed heal to the PR */
  async apply(healId: string): Promise<ApplyHealResponse> {
    validateId(healId, "Heal ID");
    return this.#client.request<ApplyHealResponse>(
      `/v1/heal/${encodeURIComponent(healId)}/apply`,
      { method: "POST" }
    );
  }

  /** Reject a heal */
  async reject(healId: string, reason?: string): Promise<RejectHealResponse> {
    validateId(healId, "Heal ID");
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== "string" || reason.trim() === "") {
        throw new Error("Reason must be a non-empty string if provided");
      }
    }
    return this.#client.request<RejectHealResponse>(
      `/v1/heal/${encodeURIComponent(healId)}/reject`,
      { method: "POST", body: reason ? { reason } : undefined }
    );
  }
}
