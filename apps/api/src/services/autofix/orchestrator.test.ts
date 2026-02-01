import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEnv, createMockKv } from "../../test-helpers/mock-env";
import type { Env } from "../../types/env";

// ============================================================================
// Mocks
// ============================================================================

const mockGetHealsByPr = vi.fn();

// Mock createHeal to return predictable IDs
let healIdCounter = 0;
interface HealData {
  errorIds: string[];
  signatureIds: string[];
  autofixSource: string;
  autofixCommand: string;
  commitMessage: string;
  type: string;
  projectId: string;
  runId: string;
  commitSha: string;
  prNumber: number;
}
const mockCreateHeal = vi.fn((_env: unknown, _data: HealData) =>
  Promise.resolve(`heal-${++healIdCounter}`)
);

vi.mock("../../db/operations/heals", () => ({
  createHeal: (env: unknown, data: HealData) => mockCreateHeal(env, data),
  getHealsByPr: (...args: unknown[]) => mockGetHealsByPr(...args),
}));

// Mock KV namespace
const mockKvGet = vi.fn();
const mockKvPut = vi.fn();
const mockKvDelete = vi.fn();
const mockKvList = vi.fn();
const mockKvGetWithMetadata = vi.fn();

const mockKv = {
  ...createMockKv(),
  get: mockKvGet,
  put: mockKvPut,
  delete: mockKvDelete,
  list: mockKvList,
  getWithMetadata: mockKvGetWithMetadata,
};

// Mock idempotency functions
const mockAcquireHealCreationLock = vi.fn();
const mockReleaseHealCreationLock = vi.fn();

vi.mock("../idempotency", () => ({
  acquireHealCreationLock: (...args: unknown[]) =>
    mockAcquireHealCreationLock(...args),
  releaseHealCreationLock: (...args: unknown[]) =>
    mockReleaseHealCreationLock(...args),
}));

const createTestEnv = (overrides: Partial<Env> = {}): Env =>
  createMockEnv({
    "detent-idempotency": mockKv,
    ...overrides,
  });

// ============================================================================
// Test Setup
// ============================================================================

// Helper to get orchestrator with fresh imports
const getOrchestrator = async () => import("./orchestrator");

// Flush promise queue to allow fire-and-forget async operations to complete
// Uses multiple iterations to handle nested promises
const flushPromises = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// Default org settings with autofix enabled
const defaultOrgSettings = {
  autofixEnabled: true,
  autofixSources: ["biome", "eslint", "prettier"],
  healEnabled: true,
};

// Helper to create test context
const createTestContext = (overrides = {}) => ({
  env: createTestEnv(),
  projectId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  runId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  commitSha: "abc123def456",
  prNumber: 42,
  branch: "feature/test",
  repoFullName: "owner/repo",
  installationId: 12_345,
  errors: [],
  orgSettings: defaultOrgSettings,
  ...overrides,
});

describe("orchestrateHeals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    healIdCounter = 0;

    // Default mock behaviors
    mockAcquireHealCreationLock.mockResolvedValue({ acquired: true });
    mockReleaseHealCreationLock.mockResolvedValue(undefined);
    mockGetHealsByPr.mockResolvedValue([]);
  });

  // ==========================================================================
  // Error Filtering - Only errors with fixable: true AND valid source
  // ==========================================================================

  describe("error filtering", () => {
    it("returns early when autofix is disabled in org settings", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          orgSettings: { ...defaultOrgSettings, autofixEnabled: false },
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      expect(result).toEqual({
        healsCreated: 0,
        healIds: [],
        autofixes: [],
        partialFailures: [],
      });
      expect(mockCreateHeal).not.toHaveBeenCalled();
    });

    it("skips errors without fixable: true", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: false },
            { id: "err-2", source: "eslint", fixable: undefined },
          ],
        })
      );

      expect(result).toEqual({
        healsCreated: 0,
        healIds: [],
        autofixes: [],
        partialFailures: [],
      });
      expect(mockCreateHeal).not.toHaveBeenCalled();
    });

    it("skips errors without a valid source", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", fixable: true }, // no source
            { id: "err-2", source: "", fixable: true }, // empty source
            { id: "err-3", source: undefined, fixable: true },
          ],
        })
      );

      expect(result).toEqual({
        healsCreated: 0,
        healIds: [],
        autofixes: [],
        partialFailures: [],
      });
      expect(mockCreateHeal).not.toHaveBeenCalled();
    });

    it("skips errors with unknown autofix source", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "unknown-linter", fixable: true },
            { id: "err-2", source: "typescript", fixable: true }, // typescript has no autofix command
          ],
        })
      );

      expect(result).toEqual({
        healsCreated: 0,
        healIds: [],
        autofixes: [],
        partialFailures: [],
      });
      expect(mockCreateHeal).not.toHaveBeenCalled();
    });

    it("processes only errors with both fixable: true AND valid autofix source", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true }, // valid
            { id: "err-2", source: "biome", fixable: false }, // not fixable
            { id: "err-3", source: "unknown", fixable: true }, // unknown source
            { id: "err-4", source: "eslint", fixable: true }, // valid
          ],
        })
      );

      await flushPromises();

      // Should create 2 heals (one for biome, one for eslint)
      expect(result.healsCreated).toBe(2);
      expect(mockCreateHeal).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Grouping by Source - Errors grouped by source (biome, eslint, etc.)
  // ==========================================================================

  describe("grouping by source", () => {
    it("groups multiple errors with same source into single heal", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            {
              id: "err-1",
              source: "biome",
              fixable: true,
              signatureId: "sig-1",
            },
            {
              id: "err-2",
              source: "biome",
              fixable: true,
              signatureId: "sig-2",
            },
            {
              id: "err-3",
              source: "biome",
              fixable: true,
              signatureId: "sig-1",
            },
          ],
        })
      );

      await flushPromises();

      // Only one heal created for all biome errors
      expect(result.healsCreated).toBe(1);
      expect(mockCreateHeal).toHaveBeenCalledTimes(1);

      // Verify errorIds includes all errors
      const createHealCall = mockCreateHeal.mock.calls[0]?.[1] as
        | HealData
        | undefined;
      expect(createHealCall?.errorIds).toEqual(["err-1", "err-2", "err-3"]);
    });

    it("creates separate heals for different sources", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
            { id: "err-3", source: "prettier", fixable: true },
          ],
        })
      );

      await flushPromises();

      // Three heals created (one per source)
      expect(result.healsCreated).toBe(3);
      expect(mockCreateHeal).toHaveBeenCalledTimes(3);
    });

    it("normalizes source names to lowercase", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "BIOME", fixable: true },
            { id: "err-2", source: "Biome", fixable: true },
            { id: "err-3", source: "biome", fixable: true },
          ],
        })
      );

      await flushPromises();

      // All grouped into single heal despite different case
      expect(result.healsCreated).toBe(1);
      expect(mockCreateHeal).toHaveBeenCalledTimes(1);
    });

    it("deduplicates signature IDs within a source group", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      await orchestrateHeals(
        createTestContext({
          errors: [
            {
              id: "err-1",
              source: "biome",
              fixable: true,
              signatureId: "sig-1",
            },
            {
              id: "err-2",
              source: "biome",
              fixable: true,
              signatureId: "sig-1",
            },
            {
              id: "err-3",
              source: "biome",
              fixable: true,
              signatureId: "sig-2",
            },
          ],
        })
      );

      await flushPromises();

      const createHealCall = mockCreateHeal.mock.calls[0]?.[1] as
        | HealData
        | undefined;
      // signatureIds should be deduplicated
      expect(createHealCall?.signatureIds).toEqual(["sig-1", "sig-2"]);
    });
  });

  // ==========================================================================
  // Deduplication - No duplicate heals for same source on same PR
  // ==========================================================================

  describe("deduplication", () => {
    it("skips creating heal when pending heal already exists for source on PR", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      // Existing pending heal for biome
      mockGetHealsByPr.mockResolvedValueOnce([
        {
          id: "existing-heal",
          autofixSource: "biome",
          status: "pending",
          type: "autofix",
        },
      ]);

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
          ],
        })
      );

      await flushPromises();

      // Only eslint heal should be created
      expect(result.healsCreated).toBe(1);
      expect(mockCreateHeal).toHaveBeenCalledTimes(1);

      const createHealCall = mockCreateHeal.mock.calls[0]?.[1] as
        | HealData
        | undefined;
      expect(createHealCall?.autofixSource).toBe("eslint");
    });

    it("skips creating heal when running heal exists for source on PR", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      // Existing running heal for eslint
      mockGetHealsByPr.mockResolvedValueOnce([
        {
          id: "existing-heal",
          autofixSource: "eslint",
          status: "running",
          type: "autofix",
        },
      ]);

      const result = await orchestrateHeals(
        createTestContext({
          errors: [{ id: "err-1", source: "eslint", fixable: true }],
        })
      );

      await flushPromises();

      expect(result.healsCreated).toBe(0);
      expect(result.autofixes).toEqual([]);
      expect(mockCreateHeal).not.toHaveBeenCalled();
    });

    it("creates heal when only completed/failed heals exist for source", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      // Existing completed heal for biome (should not block new heal)
      mockGetHealsByPr.mockResolvedValueOnce([
        {
          id: "old-heal-1",
          autofixSource: "biome",
          status: "completed",
          type: "autofix",
        },
        {
          id: "old-heal-2",
          autofixSource: "biome",
          status: "failed",
          type: "autofix",
        },
        {
          id: "old-heal-3",
          autofixSource: "biome",
          status: "rejected",
          type: "autofix",
        },
      ]);

      const result = await orchestrateHeals(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      await flushPromises();

      // Should create new heal since no pending/running exists
      expect(result.healsCreated).toBe(1);
      expect(mockCreateHeal).toHaveBeenCalledTimes(1);
    });

    it("skips source when KV lock cannot be acquired", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      // First lock acquired, second fails
      mockAcquireHealCreationLock
        .mockResolvedValueOnce({ acquired: true })
        .mockResolvedValueOnce({ acquired: false });

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
          ],
        })
      );

      await flushPromises();

      // Only one heal created (biome has higher priority and gets first lock)
      expect(result.healsCreated).toBe(1);
      expect(mockCreateHeal).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Heal Record Creation - Correct fields set on heal record
  // ==========================================================================

  describe("heal record creation", () => {
    it("creates heal with correct type and status", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      await orchestrateHeals(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      await flushPromises();

      expect(mockCreateHeal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "autofix",
        })
      );
    });

    it("includes all required fields from context", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const ctx = createTestContext({
        projectId: "project-123",
        runId: "run-456",
        commitSha: "abc123",
        prNumber: 99,
        errors: [{ id: "err-1", source: "eslint", fixable: true }],
      });

      await orchestrateHeals(ctx);
      await flushPromises();

      expect(mockCreateHeal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          projectId: "project-123",
          runId: "run-456",
          commitSha: "abc123",
          prNumber: 99,
        })
      );
    });

    it("sets autofixSource and autofixCommand from registry", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      await orchestrateHeals(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      await flushPromises();

      expect(mockCreateHeal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          autofixSource: "biome",
          autofixCommand: "biome check --write .",
        })
      );
    });

    it("generates commit message based on source and error count", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "biome", fixable: true },
            { id: "err-3", source: "biome", fixable: true },
          ],
        })
      );

      await flushPromises();

      expect(mockCreateHeal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          commitMessage:
            "fix(autofix): Apply biome formatting fixes (3 issues)",
        })
      );
    });

    it("collects error IDs and signature IDs correctly", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      await orchestrateHeals(
        createTestContext({
          errors: [
            {
              id: "err-1",
              source: "prettier",
              fixable: true,
              signatureId: "sig-a",
            },
            { id: "err-2", source: "prettier", fixable: true },
            {
              id: "err-3",
              source: "prettier",
              fixable: true,
              signatureId: "sig-b",
            },
          ],
        })
      );

      await flushPromises();

      expect(mockCreateHeal).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          errorIds: ["err-1", "err-2", "err-3"],
          signatureIds: ["sig-a", "sig-b"],
        })
      );
    });

    it("returns heal IDs from created heals", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
          ],
        })
      );

      await flushPromises();

      expect(result.healIds).toHaveLength(2);
      expect(result.healIds).toContain("heal-1");
      expect(result.healIds).toContain("heal-2");
    });

    it("returns autofixes with healId, source, and command", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
          ],
        })
      );

      await flushPromises();

      expect(result.autofixes).toHaveLength(2);
      expect(result.autofixes).toContainEqual({
        healId: "heal-1",
        source: "biome",
        command: "biome check --write .",
      });
      expect(result.autofixes).toContainEqual({
        healId: "heal-2",
        source: "eslint",
        command: "eslint --fix .",
      });
    });
  });

  // ==========================================================================
  // Priority Ordering - Higher priority sources processed first
  // ==========================================================================

  describe("priority ordering", () => {
    it("processes sources in priority order (biome > eslint > prettier)", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      // Track order of createHeal calls
      const callOrder: string[] = [];
      mockCreateHeal.mockImplementation((_db: unknown, data: HealData) => {
        callOrder.push(data.autofixSource);
        return Promise.resolve(`heal-${callOrder.length}`);
      });

      await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "prettier", fixable: true }, // priority 80
            { id: "err-2", source: "eslint", fixable: true }, // priority 90
            { id: "err-3", source: "biome", fixable: true }, // priority 100
          ],
        })
      );

      await flushPromises();

      // Should be called in priority order: biome (100) > eslint (90) > prettier (80)
      expect(callOrder).toEqual(["biome", "eslint", "prettier"]);
    });

    it("continues processing remaining sources when one fails", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      // First heal creation fails, second succeeds
      mockCreateHeal
        .mockRejectedValueOnce(new Error("DB error"))
        .mockResolvedValueOnce("heal-2");

      const result = await orchestrateHeals(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
          ],
        })
      );

      await flushPromises();

      // Should still create one heal despite first failure
      expect(result.healsCreated).toBe(1);
      expect(result.healIds).toEqual(["heal-2"]);
    });

    it("releases lock on error during heal creation", async () => {
      const { orchestrateHeals } = await getOrchestrator();

      mockCreateHeal.mockRejectedValueOnce(new Error("DB error"));

      await orchestrateHeals(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      await flushPromises();

      // Lock should be released after error
      expect(mockReleaseHealCreationLock).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Graceful Degradation
  // ==========================================================================

  describe("graceful degradation", () => {
    it("returns empty result when Convex query fails", async () => {
      mockGetHealsByPr.mockRejectedValueOnce(new Error("Convex query failed"));

      const { orchestrateHeals } = await getOrchestrator();

      const result = await orchestrateHeals(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      expect(result).toEqual({
        healsCreated: 0,
        healIds: [],
        autofixes: [],
        partialFailures: [],
      });
    });
  });
});
