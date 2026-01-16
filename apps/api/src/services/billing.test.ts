import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/env";

// ============================================================================
// Mocks
// ============================================================================

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockValues = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn();
const mockFrom = vi.fn();

const mockDb = {
  insert: mockInsert,
  update: mockUpdate,
  select: mockSelect,
  query: {
    organizations: { findFirst: mockFindFirst },
    usageEvents: { findMany: mockFindMany },
  },
};

const mockClient = { end: vi.fn() };

vi.mock("../db/client", () => ({
  createDb: vi.fn(() => Promise.resolve({ db: mockDb, client: mockClient })),
}));

const mockIngestUsageEvents = vi.fn();
const mockGetCustomerStateByExternalId = vi.fn();
vi.mock("./polar", () => ({
  createPolarClient: vi.fn(() => ({})),
  ingestUsageEvents: (...args: unknown[]) => mockIngestUsageEvents(...args),
  getCustomerStateByExternalId: (...args: unknown[]) =>
    mockGetCustomerStateByExternalId(...args),
}));

// Mock environment
const createMockEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    HYPERDRIVE: {
      connectionString: "postgres://test:test@localhost:5432/test",
    },
    POLAR_ACCESS_TOKEN: "polar_test_token",
    POLAR_ORGANIZATION_ID: "polar_org_123",
    ...overrides,
  }) as Env;

// ============================================================================
// Test Setup
// ============================================================================

const setupMockChains = () => {
  // Insert chain: insert().values()
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockResolvedValue([]);

  // Update chain: update().set().where()
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue([]);

  // Select chain: select().from().where()
  mockSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
};

// Helper to get billing functions with fresh imports
const getBilling = async () => import("./billing");

// Flush promise queue to allow fire-and-forget async operations to complete
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

describe("billing service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockChains();
    mockIngestUsageEvents.mockResolvedValue(undefined);
  });

  // ==========================================================================
  // BYOK Behavior - AI usage with byok=true should NOT record usage
  // ==========================================================================

  describe("recordUsage - BYOK behavior", () => {
    it("skips recording when byok=true for AI usage", async () => {
      const { recordUsage } = await getBilling();
      const env = createMockEnv();

      await recordUsage(
        env,
        "org-123",
        "run-456",
        {
          type: "ai",
          model: "claude-3",
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          costUSD: 0.05,
        },
        true // byok=true
      );

      // Should NOT insert to database
      expect(mockInsert).not.toHaveBeenCalled();
      // Should NOT ingest to Polar
      expect(mockIngestUsageEvents).not.toHaveBeenCalled();
      // Should NOT close db connection (never opened)
      expect(mockClient.end).not.toHaveBeenCalled();
    });

    it("records sandbox usage even when byok=true (byok only applies to AI)", async () => {
      const { recordUsage } = await getBilling();
      const env = createMockEnv();

      await recordUsage(
        env,
        "org-123",
        "run-456",
        {
          type: "sandbox",
          durationMinutes: 5,
          costUSD: 0.1,
        },
        true // byok=true - should be ignored for sandbox
      );

      // Should insert to database
      expect(mockInsert).toHaveBeenCalled();
      // DB connection should be closed
      expect(mockClient.end).toHaveBeenCalled();
    });

    it("records AI usage when byok=false", async () => {
      const { recordUsage } = await getBilling();
      const env = createMockEnv();

      await recordUsage(
        env,
        "org-123",
        "run-456",
        {
          type: "ai",
          model: "claude-3",
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 200,
          costUSD: 0.05,
        },
        false // byok=false
      );

      expect(mockInsert).toHaveBeenCalled();
      expect(mockClient.end).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Metadata building correctness
  // ==========================================================================

  describe("recordUsage - metadata building", () => {
    it("builds correct local metadata for AI usage", async () => {
      const { recordUsage } = await getBilling();
      const env = createMockEnv();

      await recordUsage(
        env,
        "org-123",
        "run-456",
        {
          type: "ai",
          model: "claude-sonnet-4-20250514",
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 200,
          costUSD: 0.05,
        },
        false
      );

      // Check the metadata passed to insert
      const insertCall = mockValues.mock.calls[0]?.[0];
      expect(insertCall.eventName).toBe("ai");
      expect(insertCall.metadata).toMatchObject({
        runId: "run-456",
        model: "claude-sonnet-4-20250514",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        costUSD: 0.05,
      });
    });

    it("builds correct local metadata for sandbox usage", async () => {
      const { recordUsage } = await getBilling();
      const env = createMockEnv();

      await recordUsage(
        env,
        "org-123",
        "run-456",
        {
          type: "sandbox",
          durationMinutes: 15,
          costUSD: 0.25,
        },
        false
      );

      const insertCall = mockValues.mock.calls[0]?.[0];
      expect(insertCall.eventName).toBe("sandbox");
      expect(insertCall.metadata).toMatchObject({
        runId: "run-456",
        durationMinutes: 15,
        costUSD: 0.25,
      });
    });

    it("builds correct Polar metadata for AI usage with unified event name", async () => {
      const { recordUsage } = await getBilling();
      const env = createMockEnv();

      await recordUsage(
        env,
        "org-123",
        "run-456",
        {
          type: "ai",
          model: "claude-3",
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          costUSD: 0.05,
        },
        false
      );

      // Flush promises to allow fire-and-forget Polar ingestion to complete
      await flushPromises();

      expect(mockIngestUsageEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([
          expect.objectContaining({
            name: "usage", // Unified event name
            externalCustomerId: "org-123",
            metadata: {
              type: "ai",
              cost_usd: 0.05,
              model: "claude-3",
              tokens: 1500, // inputTokens + outputTokens
            },
          }),
        ])
      );
    });

    it("builds correct Polar metadata for sandbox usage", async () => {
      const { recordUsage } = await getBilling();
      const env = createMockEnv();

      await recordUsage(
        env,
        "org-123",
        "run-456",
        {
          type: "sandbox",
          durationMinutes: 10,
          costUSD: 0.2,
        },
        false
      );

      // Flush promises to allow fire-and-forget Polar ingestion to complete
      await flushPromises();

      expect(mockIngestUsageEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([
          expect.objectContaining({
            name: "usage",
            externalCustomerId: "org-123",
            metadata: {
              type: "sandbox",
              cost_usd: 0.2,
              duration_minutes: 10,
            },
          }),
        ])
      );
    });
  });

  // ==========================================================================
  // canRunHeal - billing check behavior
  // ==========================================================================

  describe("canRunHeal", () => {
    it("allows heal when POLAR_ACCESS_TOKEN is not configured (dev mode)", async () => {
      const { canRunHeal } = await getBilling();
      const env = createMockEnv({ POLAR_ACCESS_TOKEN: undefined });

      const result = await canRunHeal(env, "org-123");

      expect(result).toEqual({ allowed: true });
      // Should not query database when Polar is not configured
      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it("denies heal when organization is not found", async () => {
      const { canRunHeal } = await getBilling();
      const env = createMockEnv();
      mockFindFirst.mockResolvedValue(undefined);

      const result = await canRunHeal(env, "nonexistent-org");

      expect(result).toEqual({
        allowed: false,
        reason: "Organization not found",
      });
      expect(mockClient.end).toHaveBeenCalled();
    });

    it("denies heal when customer not found in Polar", async () => {
      const { canRunHeal } = await getBilling();
      const env = createMockEnv();
      mockFindFirst.mockResolvedValue({ id: "org-123", name: "Test Org" });
      mockGetCustomerStateByExternalId.mockResolvedValue(null);

      const result = await canRunHeal(env, "org-123");

      expect(result).toEqual({
        allowed: false,
        reason: "No active subscription. Please subscribe to use healing.",
      });
      expect(mockClient.end).toHaveBeenCalled();
    });

    it("allows heal when customer has active subscription", async () => {
      const { canRunHeal } = await getBilling();
      const env = createMockEnv();
      mockFindFirst.mockResolvedValue({ id: "org-123", name: "Test Org" });
      mockGetCustomerStateByExternalId.mockResolvedValue({
        activeSubscriptions: [{ id: "sub-1", status: "active" }],
        activeMeters: [],
      });

      const result = await canRunHeal(env, "org-123");

      expect(result).toEqual({ allowed: true });
      expect(mockClient.end).toHaveBeenCalled();
    });

    it("allows heal when customer has meter credits", async () => {
      const { canRunHeal } = await getBilling();
      const env = createMockEnv();
      mockFindFirst.mockResolvedValue({ id: "org-123", name: "Test Org" });
      mockGetCustomerStateByExternalId.mockResolvedValue({
        activeSubscriptions: [],
        activeMeters: [{ meterId: "meter-1", balance: 50 }],
      });

      const result = await canRunHeal(env, "org-123");

      expect(result).toEqual({ allowed: true });
      expect(mockClient.end).toHaveBeenCalled();
    });

    it("denies heal when no active subscription and no credits", async () => {
      const { canRunHeal } = await getBilling();
      const env = createMockEnv();
      mockFindFirst.mockResolvedValue({ id: "org-123", name: "Test Org" });
      mockGetCustomerStateByExternalId.mockResolvedValue({
        activeSubscriptions: [{ id: "sub-1", status: "canceled" }],
        activeMeters: [{ meterId: "meter-1", balance: 0 }],
      });

      const result = await canRunHeal(env, "org-123");

      expect(result).toEqual({
        allowed: false,
        reason: "No credits remaining. Please add more credits to continue.",
      });
      expect(mockClient.end).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // getCreditUsageSummary - percentage calculations
  // ==========================================================================

  describe("getCreditUsageSummary", () => {
    it("handles division by zero when total cost is 0", async () => {
      const { getCreditUsageSummary } = await getBilling();
      const env = createMockEnv();

      // Mock aggregates with zero costs
      mockWhere.mockResolvedValueOnce([
        {
          totalCostUSD: 0,
          aiCostUSD: 0,
          sandboxCostUSD: 0,
          eventCount: 0,
        },
      ]);
      // Mock recent events
      mockFindMany.mockResolvedValueOnce([]);

      const result = await getCreditUsageSummary(env, "org-123");

      expect(result.breakdown.ai.percentage).toBe(0);
      expect(result.breakdown.sandbox.percentage).toBe(0);
      expect(result.totalCostUSD).toBe(0);
      expect(mockClient.end).toHaveBeenCalled();
    });

    it("calculates correct percentages for mixed usage", async () => {
      const { getCreditUsageSummary } = await getBilling();
      const env = createMockEnv();

      // 75% AI, 25% sandbox
      mockWhere.mockResolvedValueOnce([
        {
          totalCostUSD: 1.0,
          aiCostUSD: 0.75,
          sandboxCostUSD: 0.25,
          eventCount: 10,
        },
      ]);
      mockFindMany.mockResolvedValueOnce([]);

      const result = await getCreditUsageSummary(env, "org-123");

      expect(result.breakdown.ai.percentage).toBe(75);
      expect(result.breakdown.sandbox.percentage).toBe(25);
      expect(result.totalCostUSD).toBe(1.0);
      expect(result.eventCount).toBe(10);
    });

    it("handles empty aggregate result gracefully", async () => {
      const { getCreditUsageSummary } = await getBilling();
      const env = createMockEnv();

      // Empty result from aggregation
      mockWhere.mockResolvedValueOnce([]);
      mockFindMany.mockResolvedValueOnce([]);

      const result = await getCreditUsageSummary(env, "org-123");

      expect(result.totalCostUSD).toBe(0);
      expect(result.breakdown.ai.costUSD).toBe(0);
      expect(result.breakdown.sandbox.costUSD).toBe(0);
      expect(result.eventCount).toBe(0);
    });
  });

  // ==========================================================================
  // retryFailedPolarIngestions - error handling and batching
  // ==========================================================================

  describe("retryFailedPolarIngestions", () => {
    it("returns zeros when no failed events exist", async () => {
      const { retryFailedPolarIngestions } = await getBilling();
      const env = createMockEnv();
      mockFindMany.mockResolvedValue([]);

      const result = await retryFailedPolarIngestions(env);

      expect(result).toEqual({ processed: 0, succeeded: 0, failed: 0 });
      expect(mockIngestUsageEvents).not.toHaveBeenCalled();
      expect(mockClient.end).toHaveBeenCalled();
    });

    it("batches events by organization for efficient ingestion", async () => {
      const { retryFailedPolarIngestions } = await getBilling();
      const env = createMockEnv();

      mockFindMany.mockResolvedValue([
        {
          id: "event-1",
          organizationId: "org-A",
          eventName: "ai",
          metadata: {
            model: "claude-3",
            inputTokens: 100,
            outputTokens: 50,
            costUSD: 0.01,
          },
        },
        {
          id: "event-2",
          organizationId: "org-A",
          eventName: "sandbox",
          metadata: { durationMinutes: 5, costUSD: 0.05 },
        },
        {
          id: "event-3",
          organizationId: "org-B",
          eventName: "ai",
          metadata: {
            model: "claude-3",
            inputTokens: 200,
            outputTokens: 100,
            costUSD: 0.02,
          },
        },
      ]);

      await retryFailedPolarIngestions(env);

      // Should call ingestUsageEvents twice - once per org
      expect(mockIngestUsageEvents).toHaveBeenCalledTimes(2);

      // Org A batch (2 events)
      expect(mockIngestUsageEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([
          expect.objectContaining({ externalCustomerId: "org-A" }),
          expect.objectContaining({ externalCustomerId: "org-A" }),
        ])
      );

      // Org B batch (1 event)
      expect(mockIngestUsageEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([
          expect.objectContaining({ externalCustomerId: "org-B" }),
        ])
      );
    });

    it("continues processing other orgs when one org fails", async () => {
      const { retryFailedPolarIngestions } = await getBilling();
      const env = createMockEnv();

      mockFindMany.mockResolvedValue([
        {
          id: "event-1",
          organizationId: "org-A",
          eventName: "ai",
          metadata: {
            model: "claude-3",
            inputTokens: 100,
            outputTokens: 50,
            costUSD: 0.01,
          },
        },
        {
          id: "event-2",
          organizationId: "org-B",
          eventName: "ai",
          metadata: {
            model: "claude-3",
            inputTokens: 200,
            outputTokens: 100,
            costUSD: 0.02,
          },
        },
      ]);

      // First org fails after all retries, second succeeds
      mockIngestUsageEvents
        .mockRejectedValueOnce(new Error("Polar API error"))
        .mockRejectedValueOnce(new Error("Polar API error"))
        .mockRejectedValueOnce(new Error("Polar API error"))
        .mockResolvedValueOnce(undefined);

      const result = await retryFailedPolarIngestions(env);

      // One event failed (org-A), one succeeded (org-B)
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
    });

    it("builds retry metadata correctly for AI events", async () => {
      const { retryFailedPolarIngestions } = await getBilling();
      const env = createMockEnv();

      mockFindMany.mockResolvedValue([
        {
          id: "event-1",
          organizationId: "org-A",
          eventName: "ai",
          metadata: {
            model: "claude-sonnet-4-20250514",
            inputTokens: 1000,
            outputTokens: 500,
            costUSD: 0.05,
          },
        },
      ]);

      await retryFailedPolarIngestions(env);

      expect(mockIngestUsageEvents).toHaveBeenCalledWith(expect.anything(), [
        {
          name: "usage",
          externalCustomerId: "org-A",
          metadata: {
            type: "ai",
            cost_usd: 0.05,
            model: "claude-sonnet-4-20250514",
            tokens: 1500,
          },
        },
      ]);
    });

    it("builds retry metadata correctly for sandbox events", async () => {
      const { retryFailedPolarIngestions } = await getBilling();
      const env = createMockEnv();

      mockFindMany.mockResolvedValue([
        {
          id: "event-1",
          organizationId: "org-A",
          eventName: "sandbox",
          metadata: {
            durationMinutes: 10,
            costUSD: 0.2,
          },
        },
      ]);

      await retryFailedPolarIngestions(env);

      expect(mockIngestUsageEvents).toHaveBeenCalledWith(expect.anything(), [
        {
          name: "usage",
          externalCustomerId: "org-A",
          metadata: {
            type: "sandbox",
            cost_usd: 0.2,
            duration_minutes: 10,
          },
        },
      ]);
    });

    it("handles missing metadata fields with defaults", async () => {
      const { retryFailedPolarIngestions } = await getBilling();
      const env = createMockEnv();

      mockFindMany.mockResolvedValue([
        {
          id: "event-1",
          organizationId: "org-A",
          eventName: "ai",
          metadata: { costUSD: 0.01 }, // Missing model, inputTokens, outputTokens
        },
      ]);

      await retryFailedPolarIngestions(env);

      expect(mockIngestUsageEvents).toHaveBeenCalledWith(expect.anything(), [
        expect.objectContaining({
          metadata: {
            type: "ai",
            cost_usd: 0.01,
            model: "unknown",
            tokens: 0,
          },
        }),
      ]);
    });
  });

  // ==========================================================================
  // getUsageSummary - empty results handling
  // Note: Testing with proper mock chain for select().from().where()
  // ==========================================================================

  describe("getUsageSummary", () => {
    it("returns zero runs when org has no projects", async () => {
      const { getUsageSummary } = await getBilling();
      const env = createMockEnv();

      // Mock select().from().where() for projects query - returns empty
      mockWhere.mockResolvedValueOnce([]);

      const result = await getUsageSummary(env, "org-123");

      expect(result.runs.total).toBe(0);
      expect(result.runs.successful).toBe(0);
      expect(result.runs.failed).toBe(0);
      expect(result.orgId).toBe("org-123");
      // Period should still be set
      expect(result.period.start).toBeDefined();
      expect(result.period.end).toBeDefined();
      expect(mockClient.end).toHaveBeenCalled();
    });
  });
});
