import type { DetentClient } from "../client.js";
import type {
  CheckoutResponse,
  CreateCustomerResponse,
  CreditUsageSummary,
  PortalResponse,
  UsageSummary,
} from "../types.js";

const validateOrgId = (orgId: string): void => {
  if (!orgId || typeof orgId !== "string" || orgId.trim() === "") {
    throw new Error("Organization ID must be a non-empty string");
  }
};

export class BillingResource {
  readonly #client: DetentClient;

  constructor(client: DetentClient) {
    this.#client = client;
  }

  /** Get usage summary (run stats) for the current billing period */
  async getUsage(organizationId: string): Promise<UsageSummary> {
    validateOrgId(organizationId);
    return this.#client.request<UsageSummary>(
      `/v1/billing/${encodeURIComponent(organizationId)}/usage`
    );
  }

  /** Get credit usage breakdown (AI vs sandbox costs) */
  async getCredits(organizationId: string): Promise<CreditUsageSummary> {
    validateOrgId(organizationId);
    return this.#client.request<CreditUsageSummary>(
      `/v1/billing/${encodeURIComponent(organizationId)}/credits`
    );
  }

  /** Create a billing customer for the organization */
  async createCustomer(
    organizationId: string,
    email: string,
    name?: string
  ): Promise<CreateCustomerResponse> {
    validateOrgId(organizationId);
    if (!email || typeof email !== "string" || email.trim() === "") {
      throw new Error("Email must be a non-empty string");
    }
    return this.#client.request<CreateCustomerResponse>(
      `/v1/billing/${encodeURIComponent(organizationId)}/customer`,
      { method: "POST", body: { email, name } }
    );
  }

  /** Create a checkout session for purchasing a plan */
  async createCheckout(
    organizationId: string,
    productId: string,
    options?: {
      successUrl?: string;
      customerEmail?: string;
      allowDiscountCodes?: boolean;
    }
  ): Promise<CheckoutResponse> {
    validateOrgId(organizationId);
    if (!productId || typeof productId !== "string" || productId.trim() === "") {
      throw new Error("Product ID must be a non-empty string");
    }
    return this.#client.request<CheckoutResponse>(
      `/v1/billing/${encodeURIComponent(organizationId)}/checkout`,
      { method: "POST", body: { productId, ...options } }
    );
  }

  /** Get the billing portal URL for self-service subscription management */
  async getPortalUrl(organizationId: string): Promise<PortalResponse> {
    validateOrgId(organizationId);
    return this.#client.request<PortalResponse>(
      `/v1/billing/${encodeURIComponent(organizationId)}/portal`
    );
  }
}
