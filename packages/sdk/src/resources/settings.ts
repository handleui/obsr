import type { DetentClient } from "../client.js";
import type {
  OrganizationSettings,
  UpdateSettingsResponse,
} from "../types.js";

export class SettingsResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** Update organization settings (partial update, only provided fields change) */
  async update(
    organizationId: string,
    settings: Partial<OrganizationSettings>
  ): Promise<UpdateSettingsResponse> {
    if (
      !organizationId ||
      typeof organizationId !== "string" ||
      organizationId.trim() === ""
    ) {
      throw new Error("Organization ID must be a non-empty string");
    }
    if (!settings || Object.keys(settings).length === 0) {
      throw new Error("At least one setting must be provided");
    }
    return this.#client.request<UpdateSettingsResponse>(
      `/v1/organizations/${encodeURIComponent(organizationId)}/settings`,
      { method: "PATCH", body: settings }
    );
  }
}
