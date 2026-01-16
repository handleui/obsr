import type { Polar } from "@polar-sh/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/env";
import {
  cancelCustomerSubscriptions,
  createCustomerPortalSession,
  createPolarClient,
  createPolarCustomer,
  getCustomerByExternalId,
  getPolarOrgId,
  ingestUsageEvents,
} from "./polar";

// Mock the Polar SDK
vi.mock("@polar-sh/sdk", () => ({
  Polar: vi.fn().mockImplementation((config: { accessToken: string }) => ({
    accessToken: config.accessToken,
  })),
}));

// Factory for mock Polar client
const createMockPolar = (overrides?: Partial<Polar>): Polar => {
  return {
    customers: {
      create: vi.fn(),
      list: vi.fn(),
    },
    events: {
      ingest: vi.fn(),
    },
    subscriptions: {
      list: vi.fn(),
      update: vi.fn(),
    },
    customerSessions: {
      create: vi.fn(),
    },
    ...overrides,
  } as unknown as Polar;
};

// Factory for mock environment
const createMockEnv = (overrides?: Partial<Env>): Env =>
  ({
    POLAR_ACCESS_TOKEN: "test-polar-token",
    POLAR_ORGANIZATION_ID: "polar-org-123",
    ...overrides,
  }) as Env;

describe("polar service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // createPolarClient - Error cases
  // ==========================================================================

  describe("createPolarClient", () => {
    it("throws when POLAR_ACCESS_TOKEN is missing", () => {
      const env = createMockEnv({ POLAR_ACCESS_TOKEN: undefined });

      expect(() => createPolarClient(env)).toThrow(
        "POLAR_ACCESS_TOKEN not configured"
      );
    });

    it("throws when POLAR_ACCESS_TOKEN is empty string", () => {
      const env = createMockEnv({ POLAR_ACCESS_TOKEN: "" });

      expect(() => createPolarClient(env)).toThrow(
        "POLAR_ACCESS_TOKEN not configured"
      );
    });
  });

  // ==========================================================================
  // getPolarOrgId - Error cases
  // ==========================================================================

  describe("getPolarOrgId", () => {
    it("throws when POLAR_ORGANIZATION_ID is missing", () => {
      const env = createMockEnv({ POLAR_ORGANIZATION_ID: undefined });

      expect(() => getPolarOrgId(env)).toThrow(
        "POLAR_ORGANIZATION_ID not configured"
      );
    });

    it("throws when POLAR_ORGANIZATION_ID is empty string", () => {
      const env = createMockEnv({ POLAR_ORGANIZATION_ID: "" });

      expect(() => getPolarOrgId(env)).toThrow(
        "POLAR_ORGANIZATION_ID not configured"
      );
    });

    it("returns org ID when configured", () => {
      const env = createMockEnv({ POLAR_ORGANIZATION_ID: "org-abc-123" });

      expect(getPolarOrgId(env)).toBe("org-abc-123");
    });
  });

  // ==========================================================================
  // getCustomerByExternalId - Edge cases
  // ==========================================================================

  describe("getCustomerByExternalId", () => {
    it("returns null when customer not found in results", async () => {
      const mockPolar = createMockPolar();
      (mockPolar.customers.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        result: { items: [] },
      });

      const result = await getCustomerByExternalId(
        mockPolar,
        "polar-org-123",
        "detent-org-456"
      );

      expect(result).toBeNull();
    });

    it("returns null when query matches but externalId differs", async () => {
      const mockPolar = createMockPolar();
      // API returns results but none match the exact externalId
      (mockPolar.customers.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        result: {
          items: [
            { id: "cust-1", externalId: "detent-org-999", email: "a@b.com" },
            { id: "cust-2", externalId: null, email: "c@d.com" },
          ],
        },
      });

      const result = await getCustomerByExternalId(
        mockPolar,
        "polar-org-123",
        "detent-org-456"
      );

      expect(result).toBeNull();
    });

    it("finds customer when externalId matches exactly", async () => {
      const mockPolar = createMockPolar();
      const expectedCustomer = {
        id: "cust-2",
        externalId: "detent-org-456",
        email: "found@example.com",
        name: "Found Customer",
      };

      (mockPolar.customers.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        result: {
          items: [
            { id: "cust-1", externalId: "detent-org-999", email: "a@b.com" },
            expectedCustomer,
          ],
        },
      });

      const result = await getCustomerByExternalId(
        mockPolar,
        "polar-org-123",
        "detent-org-456"
      );

      expect(result).toEqual(expectedCustomer);
    });
  });

  // ==========================================================================
  // ingestUsageEvents - Edge cases
  // ==========================================================================

  describe("ingestUsageEvents", () => {
    it("returns early without calling API when events array is empty", async () => {
      const mockPolar = createMockPolar();

      await ingestUsageEvents(mockPolar, []);

      expect(mockPolar.events.ingest).not.toHaveBeenCalled();
    });

    it("calls API with transformed events when array is non-empty", async () => {
      const mockPolar = createMockPolar();
      (mockPolar.events.ingest as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined
      );

      await ingestUsageEvents(mockPolar, [
        {
          name: "ci_run",
          externalCustomerId: "detent-org-123",
          metadata: { duration: 120 },
        },
        {
          name: "healing_attempt",
          externalCustomerId: "detent-org-456",
        },
      ]);

      expect(mockPolar.events.ingest).toHaveBeenCalledWith({
        events: [
          {
            name: "ci_run",
            externalCustomerId: "detent-org-123",
            metadata: { duration: 120 },
          },
          {
            name: "healing_attempt",
            externalCustomerId: "detent-org-456",
            metadata: undefined,
          },
        ],
      });
    });
  });

  // ==========================================================================
  // cancelCustomerSubscriptions - Partial failure handling
  // ==========================================================================

  describe("cancelCustomerSubscriptions", () => {
    it("returns 0 when customer has no active subscriptions", async () => {
      const mockPolar = createMockPolar();
      (
        mockPolar.subscriptions.list as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        result: { items: [] },
      });

      const result = await cancelCustomerSubscriptions(
        mockPolar,
        "polar-org-123",
        "customer-456"
      );

      expect(result).toBe(0);
      expect(mockPolar.subscriptions.update).not.toHaveBeenCalled();
    });

    it("cancels all subscriptions and returns count", async () => {
      const mockPolar = createMockPolar();
      (
        mockPolar.subscriptions.list as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        result: {
          items: [{ id: "sub-1" }, { id: "sub-2" }, { id: "sub-3" }],
        },
      });
      (
        mockPolar.subscriptions.update as ReturnType<typeof vi.fn>
      ).mockResolvedValue({});

      const result = await cancelCustomerSubscriptions(
        mockPolar,
        "polar-org-123",
        "customer-456"
      );

      expect(result).toBe(3);
      expect(mockPolar.subscriptions.update).toHaveBeenCalledTimes(3);
      expect(mockPolar.subscriptions.update).toHaveBeenCalledWith({
        id: "sub-1",
        subscriptionUpdate: { cancelAtPeriodEnd: true },
      });
    });

    it("continues canceling after individual subscription failure", async () => {
      const mockPolar = createMockPolar();
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      (
        mockPolar.subscriptions.list as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        result: {
          items: [{ id: "sub-1" }, { id: "sub-2" }, { id: "sub-3" }],
        },
      });

      // First succeeds, second fails, third succeeds
      (mockPolar.subscriptions.update as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("Already canceled"))
        .mockResolvedValueOnce({});

      const result = await cancelCustomerSubscriptions(
        mockPolar,
        "polar-org-123",
        "customer-456"
      );

      // Should have 2 successful cancellations
      expect(result).toBe(2);
      expect(mockPolar.subscriptions.update).toHaveBeenCalledTimes(3);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "[polar] Failed to cancel subscription sub-2:",
        expect.any(Error)
      );

      consoleWarnSpy.mockRestore();
    });

    it("returns 0 when all subscription cancellations fail", async () => {
      const mockPolar = createMockPolar();
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      (
        mockPolar.subscriptions.list as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        result: {
          items: [{ id: "sub-1" }, { id: "sub-2" }],
        },
      });

      (
        mockPolar.subscriptions.update as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("Service unavailable"));

      const result = await cancelCustomerSubscriptions(
        mockPolar,
        "polar-org-123",
        "customer-456"
      );

      expect(result).toBe(0);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);

      consoleWarnSpy.mockRestore();
    });
  });

  // ==========================================================================
  // createCustomerPortalSession - Return value
  // ==========================================================================

  describe("createCustomerPortalSession", () => {
    it("returns the customerPortalUrl from session", async () => {
      const mockPolar = createMockPolar();
      (
        mockPolar.customerSessions.create as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        customerPortalUrl: "https://polar.sh/portal/abc123",
        otherField: "ignored",
      });

      const result = await createCustomerPortalSession(
        mockPolar,
        "customer-456"
      );

      expect(result).toBe("https://polar.sh/portal/abc123");
      expect(mockPolar.customerSessions.create).toHaveBeenCalledWith({
        customerId: "customer-456",
      });
    });
  });

  // ==========================================================================
  // createPolarCustomer - Return value
  // ==========================================================================

  describe("createPolarCustomer", () => {
    it("passes correct parameters and returns customer", async () => {
      const mockPolar = createMockPolar();
      const createdCustomer = {
        id: "polar-customer-123",
        externalId: "detent-org-456",
        email: "team@example.com",
        name: "Example Team",
      };

      (
        mockPolar.customers.create as ReturnType<typeof vi.fn>
      ).mockResolvedValue(createdCustomer);

      const result = await createPolarCustomer(
        mockPolar,
        "polar-org-123",
        "detent-org-456",
        "team@example.com",
        "Example Team"
      );

      expect(result).toEqual(createdCustomer);
      expect(mockPolar.customers.create).toHaveBeenCalledWith({
        externalId: "detent-org-456",
        email: "team@example.com",
        name: "Example Team",
        organizationId: "polar-org-123",
      });
    });

    it("creates customer without name when not provided", async () => {
      const mockPolar = createMockPolar();
      (
        mockPolar.customers.create as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        id: "polar-customer-123",
        externalId: "detent-org-456",
        email: "team@example.com",
        name: null,
      });

      await createPolarCustomer(
        mockPolar,
        "polar-org-123",
        "detent-org-456",
        "team@example.com"
      );

      expect(mockPolar.customers.create).toHaveBeenCalledWith({
        externalId: "detent-org-456",
        email: "team@example.com",
        name: undefined,
        organizationId: "polar-org-123",
      });
    });
  });
});
