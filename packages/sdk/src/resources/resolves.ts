/**
 * Resolves Resource
 *
 * AI resolving operations.
 */

import type { DetentClient } from "../client.js";
import type {
  ApplyResolveResponse,
  RejectResolveResponse,
  ResolveDetailsResponse,
  ResolvesResponse,
  TriggerResolveResponse,
} from "../types.js";

export class ResolvesResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** List resolves for a project PR */
  async list(projectId: string, prNumber: number): Promise<ResolvesResponse> {
    // Validate parameters
    if (!projectId || projectId.trim() === "") {
      throw new Error("Project ID must be a non-empty string");
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error("PR number must be a positive integer");
    }

    return this.#client.request<ResolvesResponse>(
      `/v1/resolve?projectId=${encodeURIComponent(projectId)}&prNumber=${prNumber}`
    );
  }

  /** Get pending resolves for a project */
  async pending(projectId: string): Promise<ResolvesResponse> {
    // Validate parameter
    if (!projectId || projectId.trim() === "") {
      throw new Error("Project ID must be a non-empty string");
    }

    return this.#client.request<ResolvesResponse>(
      `/v1/resolve/pending?projectId=${encodeURIComponent(projectId)}`
    );
  }

  /** Get resolve details by ID */
  async get(resolveId: string): Promise<ResolveDetailsResponse> {
    // Validate parameter
    if (!resolveId || resolveId.trim() === "") {
      throw new Error("Resolve ID must be a non-empty string");
    }

    return this.#client.request<ResolveDetailsResponse>(
      `/v1/resolve/${encodeURIComponent(resolveId)}`
    );
  }

  /** Trigger resolving for a PR */
  async trigger(
    projectId: string,
    prNumber: number,
    type?: "autofix" | "resolve"
  ): Promise<TriggerResolveResponse> {
    // Validate parameters
    if (!projectId || projectId.trim() === "") {
      throw new Error("Project ID must be a non-empty string");
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error("PR number must be a positive integer");
    }

    return this.#client.request<TriggerResolveResponse>("/v1/resolve/trigger", {
      method: "POST",
      body: { projectId, prNumber, type: type ?? "autofix" },
    });
  }

  /** Trigger resolving for a specific resolve ID */
  async triggerById(resolveId: string): Promise<TriggerResolveResponse> {
    // Validate parameter
    if (!resolveId || resolveId.trim() === "") {
      throw new Error("Resolve ID must be a non-empty string");
    }

    return this.#client.request<TriggerResolveResponse>(
      `/v1/resolve/${encodeURIComponent(resolveId)}/trigger`,
      { method: "POST" }
    );
  }

  /** Apply a completed resolve to the PR */
  async apply(resolveId: string): Promise<ApplyResolveResponse> {
    // Validate parameter
    if (!resolveId || resolveId.trim() === "") {
      throw new Error("Resolve ID must be a non-empty string");
    }

    return this.#client.request<ApplyResolveResponse>(
      `/v1/resolve/${encodeURIComponent(resolveId)}/apply`,
      { method: "POST" }
    );
  }

  /** Reject a resolve */
  async reject(
    resolveId: string,
    reason?: string
  ): Promise<RejectResolveResponse> {
    // Validate parameters
    if (!resolveId || resolveId.trim() === "") {
      throw new Error("Resolve ID must be a non-empty string");
    }
    if (reason !== undefined && reason.trim() === "") {
      throw new Error("Reason must be a non-empty string if provided");
    }

    return this.#client.request<RejectResolveResponse>(
      `/v1/resolve/${encodeURIComponent(resolveId)}/reject`,
      {
        method: "POST",
        body: reason ? { reason } : undefined,
      }
    );
  }
}
