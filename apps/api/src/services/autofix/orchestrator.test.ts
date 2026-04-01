import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEnv, createMockKv } from "../../test-helpers/mock-env";
import type { Env } from "../../types/env";

// ============================================================================
// Mocks
// ============================================================================

const mockGetResolvesByPr = vi.fn();

// Mock createResolve to return predictable IDs
let resolveIdCounter = 0;
interface ResolveData {
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
const mockCreateResolve = vi.fn((_env: unknown, _data: ResolveData) =>
  Promise.resolve(`resolve-${++resolveIdCounter}`)
);

vi.mock("../../db/operations/resolves", () => ({
  createResolve: (env: unknown, data: ResolveData) =>
    mockCreateResolve(env, data),
  getResolvesByPr: (...args: unknown[]) => mockGetResolvesByPr(...args),
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
const mockAcquireResolveCreationLock = vi.fn();
const mockReleaseResolveCreationLock = vi.fn();

vi.mock("../idempotency", () => ({
  acquireResolveCreationLock: (...args: unknown[]) =>
    mockAcquireResolveCreationLock(...args),
  releaseResolveCreationLock: (...args: unknown[]) =>
    mockReleaseResolveCreationLock(...args),
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

describe("orchestrateResolves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveIdCounter = 0;

    // Default mock behaviors
    mockAcquireResolveCreationLock.mockResolvedValue({ acquired: true });
    mockReleaseResolveCreationLock.mockResolvedValue(undefined);
    mockGetResolvesByPr.mockResolvedValue([]);
  });

  // ==========================================================================
  // Error Filtering - Only errors with fixable: true AND valid source
  // ==========================================================================

  describe("error filtering", () => {
    it("returns early when autofix is disabled in org settings", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
        createTestContext({
          orgSettings: { ...defaultOrgSettings, autofixEnabled: false },
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      expect(result).toEqual({
        resolvesCreated: 0,
        resolveIds: [],
        autofixes: [],
        partialFailures: [],
      });
      expect(mockCreateResolve).not.toHaveBeenCalled();
    });

    it("skips errors without fixable: true", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: false },
            { id: "err-2", source: "eslint", fixable: undefined },
          ],
        })
      );

      expect(result).toEqual({
        resolvesCreated: 0,
        resolveIds: [],
        autofixes: [],
        partialFailures: [],
      });
      expect(mockCreateResolve).not.toHaveBeenCalled();
    });

    it("skips errors without a valid source", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", fixable: true }, // no source
            { id: "err-2", source: "", fixable: true }, // empty source
            { id: "err-3", source: undefined, fixable: true },
          ],
        })
      );

      expect(result).toEqual({
        resolvesCreated: 0,
        resolveIds: [],
        autofixes: [],
        partialFailures: [],
      });
      expect(mockCreateResolve).not.toHaveBeenCalled();
    });

    it("skips errors with unknown autofix source", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", source: "unknown-linter", fixable: true },
            { id: "err-2", source: "typescript", fixable: true }, // typescript has no autofix command
          ],
        })
      );

      expect(result).toEqual({
        resolvesCreated: 0,
        resolveIds: [],
        autofixes: [],
        partialFailures: [],
      });
      expect(mockCreateResolve).not.toHaveBeenCalled();
    });

    it("processes only errors with both fixable: true AND valid autofix source", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
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

      // Should create 2 resolves (one for biome, one for eslint)
      expect(result.resolvesCreated).toBe(2);
      expect(mockCreateResolve).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Grouping by Source - Errors grouped by source (biome, eslint, etc.)
  // ==========================================================================

  describe("grouping by source", () => {
    it("groups multiple errors with same source into single resolve", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
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

      // Only one resolve created for all biome errors
      expect(result.resolvesCreated).toBe(1);
      expect(mockCreateResolve).toHaveBeenCalledTimes(1);

      // Verify errorIds includes all errors
      const createResolveCall = mockCreateResolve.mock.calls[0]?.[1] as
        | ResolveData
        | undefined;
      expect(createResolveCall?.errorIds).toEqual(["err-1", "err-2", "err-3"]);
    });

    it("creates separate resolves for different sources", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
            { id: "err-3", source: "prettier", fixable: true },
          ],
        })
      );

      await flushPromises();

      // Three resolves created (one per source)
      expect(result.resolvesCreated).toBe(3);
      expect(mockCreateResolve).toHaveBeenCalledTimes(3);
    });

    it("normalizes source names to lowercase", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", source: "BIOME", fixable: true },
            { id: "err-2", source: "Biome", fixable: true },
            { id: "err-3", source: "biome", fixable: true },
          ],
        })
      );

      await flushPromises();

      // All grouped into single resolve despite different case
      expect(result.resolvesCreated).toBe(1);
      expect(mockCreateResolve).toHaveBeenCalledTimes(1);
    });

    it("deduplicates signature IDs within a source group", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      await orchestrateResolves(
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

      const createResolveCall = mockCreateResolve.mock.calls[0]?.[1] as
        | ResolveData
        | undefined;
      // signatureIds should be deduplicated
      expect(createResolveCall?.signatureIds).toEqual(["sig-1", "sig-2"]);
    });
  });

  // ==========================================================================
  // Deduplication - No duplicate resolves for same source on same PR
  // ==========================================================================

  describe("deduplication", () => {
    it("skips creating resolve when pending resolve already exists for source on PR", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      // Existing pending resolve for biome
      mockGetResolvesByPr.mockResolvedValueOnce([
        {
          id: "existing-resolve",
          autofixSource: "biome",
          status: "pending",
          type: "autofix",
        },
      ]);

      const result = await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
          ],
        })
      );

      await flushPromises();

      // Only eslint resolve should be created
      expect(result.resolvesCreated).toBe(1);
      expect(mockCreateResolve).toHaveBeenCalledTimes(1);

      const createResolveCall = mockCreateResolve.mock.calls[0]?.[1] as
        | ResolveData
        | undefined;
      expect(createResolveCall?.autofixSource).toBe("eslint");
    });

    it("skips creating resolve when running resolve exists for source on PR", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      // Existing running resolve for eslint
      mockGetResolvesByPr.mockResolvedValueOnce([
        {
          id: "existing-resolve",
          autofixSource: "eslint",
          status: "running",
          type: "autofix",
        },
      ]);

      const result = await orchestrateResolves(
        createTestContext({
          errors: [{ id: "err-1", source: "eslint", fixable: true }],
        })
      );

      await flushPromises();

      expect(result.resolvesCreated).toBe(0);
      expect(result.autofixes).toEqual([]);
      expect(mockCreateResolve).not.toHaveBeenCalled();
    });

    it("creates resolve when only completed/failed resolves exist for source", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      // Existing completed resolve for biome (should not block new resolve)
      mockGetResolvesByPr.mockResolvedValueOnce([
        {
          id: "old-resolve-1",
          autofixSource: "biome",
          status: "completed",
          type: "autofix",
        },
        {
          id: "old-resolve-2",
          autofixSource: "biome",
          status: "failed",
          type: "autofix",
        },
        {
          id: "old-resolve-3",
          autofixSource: "biome",
          status: "rejected",
          type: "autofix",
        },
      ]);

      const result = await orchestrateResolves(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      await flushPromises();

      // Should create new resolve since no pending/running exists
      expect(result.resolvesCreated).toBe(1);
      expect(mockCreateResolve).toHaveBeenCalledTimes(1);
    });

    it("skips source when KV lock cannot be acquired", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      // First lock acquired, second fails
      mockAcquireResolveCreationLock
        .mockResolvedValueOnce({ acquired: true })
        .mockResolvedValueOnce({ acquired: false });

      const result = await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
          ],
        })
      );

      await flushPromises();

      // Only one resolve created (biome has higher priority and gets first lock)
      expect(result.resolvesCreated).toBe(1);
      expect(mockCreateResolve).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Resolve Record Creation - Correct fields set on resolve record
  // ==========================================================================

  describe("resolve record creation", () => {
    it("creates resolve with correct type and status", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      await orchestrateResolves(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      await flushPromises();

      expect(mockCreateResolve).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "autofix",
        })
      );
    });

    it("includes all required fields from context", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const ctx = createTestContext({
        projectId: "project-123",
        runId: "run-456",
        commitSha: "abc123",
        prNumber: 99,
        errors: [{ id: "err-1", source: "eslint", fixable: true }],
      });

      await orchestrateResolves(ctx);
      await flushPromises();

      expect(mockCreateResolve).toHaveBeenCalledWith(
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
      const { orchestrateResolves } = await getOrchestrator();

      await orchestrateResolves(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      await flushPromises();

      expect(mockCreateResolve).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          autofixSource: "biome",
          autofixCommand: "biome check --write .",
        })
      );
    });

    it("generates commit message based on source and error count", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "biome", fixable: true },
            { id: "err-3", source: "biome", fixable: true },
          ],
        })
      );

      await flushPromises();

      expect(mockCreateResolve).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          commitMessage:
            "fix(autofix): Apply biome formatting fixes (3 issues)",
        })
      );
    });

    it("collects error IDs and signature IDs correctly", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      await orchestrateResolves(
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

      expect(mockCreateResolve).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          errorIds: ["err-1", "err-2", "err-3"],
          signatureIds: ["sig-a", "sig-b"],
        })
      );
    });

    it("returns resolve IDs from created resolves", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
          ],
        })
      );

      await flushPromises();

      expect(result.resolveIds).toHaveLength(2);
      expect(result.resolveIds).toContain("resolve-1");
      expect(result.resolveIds).toContain("resolve-2");
    });

    it("returns autofixes with resolveId, source, and command", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
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
        resolveId: "resolve-1",
        source: "biome",
        command: "biome check --write .",
      });
      expect(result.autofixes).toContainEqual({
        resolveId: "resolve-2",
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
      const { orchestrateResolves } = await getOrchestrator();

      // Track order of createResolve calls
      const callOrder: string[] = [];
      mockCreateResolve.mockImplementation(
        (_db: unknown, data: ResolveData) => {
          callOrder.push(data.autofixSource);
          return Promise.resolve(`resolve-${callOrder.length}`);
        }
      );

      await orchestrateResolves(
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
      const { orchestrateResolves } = await getOrchestrator();

      // First resolve creation fails, second succeeds
      mockCreateResolve
        .mockRejectedValueOnce(new Error("DB error"))
        .mockResolvedValueOnce("resolve-2");

      const result = await orchestrateResolves(
        createTestContext({
          errors: [
            { id: "err-1", source: "biome", fixable: true },
            { id: "err-2", source: "eslint", fixable: true },
          ],
        })
      );

      await flushPromises();

      // Should still create one resolve despite first failure
      expect(result.resolvesCreated).toBe(1);
      expect(result.resolveIds).toEqual(["resolve-2"]);
    });

    it("releases lock on error during resolve creation", async () => {
      const { orchestrateResolves } = await getOrchestrator();

      mockCreateResolve.mockRejectedValueOnce(new Error("DB error"));

      await orchestrateResolves(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      await flushPromises();

      // Lock should be released after error
      expect(mockReleaseResolveCreationLock).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Graceful Degradation
  // ==========================================================================

  describe("graceful degradation", () => {
    it("returns empty result when DB query fails", async () => {
      mockGetResolvesByPr.mockRejectedValueOnce(new Error("DB query failed"));

      const { orchestrateResolves } = await getOrchestrator();

      const result = await orchestrateResolves(
        createTestContext({
          errors: [{ id: "err-1", source: "biome", fixable: true }],
        })
      );

      expect(result).toEqual({
        resolvesCreated: 0,
        resolveIds: [],
        autofixes: [],
        partialFailures: [],
      });
    });
  });
});
