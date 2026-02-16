import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEnv, createMockKv } from "../test-helpers/mock-env";

// Mock the webhook signature middleware to bypass signature verification in tests
// vi.mock must be defined before dynamic import
vi.mock("../middleware/webhook-signature", () => ({
  webhookSignatureMiddleware: vi.fn(
    async (
      c: {
        req: { text: () => Promise<string> };
        set: (key: string, value: unknown) => void;
      },
      next: () => Promise<void>
    ) => {
      const rawBody = await c.req.text();
      c.set("webhookPayload", JSON.parse(rawBody));
      await next();
    }
  ),
}));

// Dynamic import required for bun test to properly apply mocks
let app: Awaited<typeof import("./webhooks")>["default"];

beforeAll(async () => {
  const module = await import("./webhooks");
  app = module.default;
});

beforeEach(() => {
  queryQueue.clear();
});

// Mock the database client - defined before vi.mock to ensure proper closure capture
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockQuery = vi.fn();
const mockMutation = vi.fn();
const mockConvex = { query: mockQuery, mutation: mockMutation };

const queryQueue = new Map<string, unknown[]>();
const queueQueryResult = (name: string, ...results: unknown[]): void => {
  const existing = queryQueue.get(name) ?? [];
  existing.push(...results);
  queryQueue.set(name, existing);
};
const setQueryResult = (name: string, result: unknown): void => {
  queryQueue.set(name, [result]);
};

vi.mock("../db/convex", () => ({
  getConvexClient: vi.fn(() => mockConvex),
}));

// Mock GitHub membership verification for autoLinkInstaller admin check
const mockVerifyGitHubMembership = vi.fn();
vi.mock("../lib/github-membership", () => ({
  verifyGitHubMembership: (...args: unknown[]) =>
    mockVerifyGitHubMembership(...args),
}));

// Mock crypto.randomUUID for deterministic suffixes
const mockUUID = "test-uuid-1234-5678-9abc-def012345678";
vi.spyOn(crypto, "randomUUID").mockImplementation(() => mockUUID);

// Mock environment
const MOCK_ENV = createMockEnv({
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  GITHUB_APP_ID: "123456",
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  WORKOS_CLIENT_ID: "test-workos-client",
  WORKOS_API_KEY: "test-workos-key",
});

// Factory for installation payloads
const createInstallationPayload = (
  action: "created" | "deleted" | "suspend" | "unsuspend",
  overrides: Partial<{
    installationId: number;
    accountId: number;
    accountLogin: string;
    accountType: "Organization" | "User";
    avatarUrl: string;
    senderId: number;
    senderLogin: string;
  }> = {}
) => ({
  action,
  installation: {
    id: overrides.installationId ?? 12_345_678,
    account: {
      id: overrides.accountId ?? 98_765_432,
      login: overrides.accountLogin ?? "test-org",
      type: overrides.accountType ?? ("Organization" as const),
      avatar_url: overrides.avatarUrl ?? "https://avatars.example.com/u/123",
    },
  },
  sender: {
    id: overrides.senderId ?? 11_111_111,
    login: overrides.senderLogin ?? "installer-user",
    type: "User" as const,
  },
});

// Helper to make webhook request
const makeWebhookRequest = async (
  event: string,
  payload: unknown
): Promise<Response> => {
  const body = JSON.stringify(payload);

  const response = await app.request(
    "/github",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": "test-delivery-id",
        "X-Hub-Signature-256": "sha256=mocked",
      },
      body,
    },
    MOCK_ENV
  );

  return response;
};

// Response JSON types for webhook events
interface InstallationResponse {
  message: string;
  organization_id?: string;
  organization_slug?: string;
  account?: string;
  action?: string;
  error?: string;
  projects_created?: number;
}

interface RepositoryResponse {
  message: string;
  project_id?: string;
  old_name?: string;
  new_name?: string;
  new_full_name?: string;
  is_private?: boolean;
  repo_id?: number;
}

interface InstallationRepositoriesResponse {
  message: string;
  organization_id?: string;
  organization_slug?: string;
  projects_added?: number;
  projects_removed?: number;
  installation_id?: number;
}

describe("webhooks - installation events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyGitHubMembership.mockReset();

    // Setup mock chain for select queries
    // Queries can either:
    // 1. Chain with .limit() for single record lookup (installation check)
    // 2. Be awaited directly for array results (slug lookup with inArray)
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });

    // Create a thenable object that also has a limit method
    // This handles both query patterns used in the code
    const createQueryResult = (result: unknown[] = []) => {
      const queryResult = Promise.resolve(result) as Promise<unknown[]> & {
        limit: ReturnType<typeof vi.fn>;
      };
      queryResult.limit = mockLimit;
      return queryResult;
    };

    mockWhere.mockImplementation(() => createQueryResult([]));
    mockLimit.mockResolvedValue([]);

    // Setup mock chain for insert
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({
      onConflictDoNothing: mockOnConflictDoNothing,
    });
    mockOnConflictDoNothing.mockResolvedValue(undefined);

    // Setup mock chain for update
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });

    mockQuery.mockReset();
    mockMutation.mockReset();
    queryQueue.clear();

    const resolveQueryResult = async (): Promise<unknown> => {
      const result = mockWhere();
      if (
        result &&
        typeof (result as { limit?: () => unknown }).limit === "function"
      ) {
        return await (result as { limit: () => Promise<unknown> }).limit();
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        return await (result as Promise<unknown>);
      }
      return result;
    };

    const singleQueryNames = new Set([
      "organizations:getByProviderAccount",
      "organizations:getByProviderAccountLogin",
      "organizations:getBySlug",
      "organizations:getById",
      "projects:getByOrgRepo",
      "projects:getByRepoId",
      "projects:getByRepoFullName",
    ]);

    const toPageArray = (value: unknown): unknown[] => {
      if (Array.isArray(value)) {
        return value;
      }
      if (value) {
        return [value];
      }
      return [];
    };

    mockQuery.mockImplementation(async (name: string) => {
      const queued = queryQueue.get(name);
      if (queued && queued.length > 0) {
        return queued.shift();
      }
      if (name === "organizations:listByProviderInstallationId") {
        return [];
      }
      const result = await resolveQueryResult();
      if (singleQueryNames.has(name)) {
        return Array.isArray(result) ? (result[0] ?? null) : (result ?? null);
      }
      if (name === "jobs:paginateByRepoCommit") {
        const page = toPageArray(result);
        return { page, isDone: true, continueCursor: "" };
      }
      return toPageArray(result);
    });

    mockMutation.mockImplementation(
      (name: string, args: Record<string, unknown>) => {
        if (
          name.includes(":create") ||
          name.includes(":createIfMissing") ||
          name === "projects:syncFromGitHub"
        ) {
          mockInsert();

          if (name === "projects:syncFromGitHub") {
            const repos =
              (args.repos as Array<{
                id: string;
                name: string;
                fullName: string;
                isPrivate: boolean;
                defaultBranch?: string;
              }>) ?? [];

            mockValues(
              repos.map((repo) => ({
                organizationId: args.organizationId,
                handle: repo.name.toLowerCase(),
                providerRepoId: String(repo.id),
                providerRepoName: repo.name,
                providerRepoFullName: repo.fullName,
                isPrivate: repo.isPrivate,
                providerDefaultBranch: repo.defaultBranch ?? null,
              }))
            );

            return { added: repos.length, removed: 0, updated: 0 };
          }

          mockValues(args);
          return args.id ?? mockUUID;
        }

        if (
          name.includes(":update") ||
          name.includes(":remove") ||
          name.includes(":softDelete")
        ) {
          mockUpdate();
          mockSet(args);
          return args.id ?? null;
        }

        return null;
      }
    );
  });

  describe("installation.created", () => {
    it("creates a new organization with correct fields", async () => {
      const payload = createInstallationPayload("created");

      const res = await makeWebhookRequest("installation", payload);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        message: "installation created",
        organization_id: mockUUID,
        organization_slug: "gh/test-org",
        account: "test-org",
        projects_created: 0,
      });

      // Verify insert was called with correct values
      expect(mockInsert).toHaveBeenCalled();
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "test-org",
          slug: "gh/test-org",
          provider: "github",
          providerAccountId: "98765432",
          providerAccountLogin: "test-org",
          providerAccountType: "organization",
          providerInstallationId: "12345678",
          providerAvatarUrl: "https://avatars.example.com/u/123",
          installerGithubId: "11111111",
        })
      );
    });

    it("creates organization for User account type", async () => {
      const payload = createInstallationPayload("created", {
        accountType: "User",
        accountLogin: "my-user",
      });

      const res = await makeWebhookRequest("installation", payload);
      const json = (await res.json()) as InstallationResponse;

      expect(res.status).toBe(200);
      expect(json.organization_slug).toBe("gh/my-user");

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          providerAccountType: "user",
        })
      );
    });

    it("normalizes slug to lowercase with gh/ prefix", async () => {
      const payload = createInstallationPayload("created", {
        accountLogin: "My_Test_Org",
      });

      const res = await makeWebhookRequest("installation", payload);
      const json = (await res.json()) as InstallationResponse;

      expect(res.status).toBe(200);
      expect(json.organization_slug).toBe("gh/my_test_org");
    });

    it("handles null avatar URL", async () => {
      const payload = createInstallationPayload("created");
      // biome-ignore lint/performance/noDelete: Testing undefined field behavior
      delete (payload.installation.account as Record<string, unknown>)
        .avatar_url;

      const res = await makeWebhookRequest("installation", payload);

      expect(res.status).toBe(200);
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          providerAvatarUrl: null,
        })
      );
    });
  });

  describe("autoLinkInstaller - admin verification", () => {
    // Security: autoLinkInstaller should verify installer is a GitHub admin
    // before granting owner role (for organizations, not personal accounts)

    it("auto-links installer as owner when they are a GitHub admin", async () => {
      setQueryResult("organizations:getByProviderAccount", null);
      setQueryResult("organizations:listByProviderInstallationId", []);
      setQueryResult("organizations:getBySlug", null);
      setQueryResult("organization_members:listByProviderUserId", [
        { userId: "existing-detent-user" },
      ]);
      setQueryResult("organization_members:getByOrgUser", null);

      // Mock: installer is a GitHub admin
      mockVerifyGitHubMembership.mockResolvedValueOnce({
        isMember: true,
        role: "admin",
      });

      const payload = createInstallationPayload("created", {
        accountType: "Organization",
        senderLogin: "admin-installer",
      });

      const res = await makeWebhookRequest("installation", payload);

      expect(res.status).toBe(200);

      // Verify verifyGitHubMembership was called for the organization
      expect(mockVerifyGitHubMembership).toHaveBeenCalledWith(
        "admin-installer", // username
        "test-org", // org login
        "12345678", // installation id
        expect.any(Object) // env
      );

      // Verify owner membership was created (insert called with role: owner)
      // The org insert is first, then the member insert
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "existing-detent-user",
          role: "owner",
          providerUsername: "admin-installer",
        })
      );
    });

    it("does NOT auto-link installer when they are only a GitHub member (not admin)", async () => {
      setQueryResult("organizations:getByProviderAccount", null);
      setQueryResult("organizations:listByProviderInstallationId", []);
      setQueryResult("organizations:getBySlug", null);
      setQueryResult("organization_members:listByProviderUserId", [
        { userId: "existing-detent-user" },
      ]);
      setQueryResult("organization_members:getByOrgUser", null);

      // Mock: installer is only a GitHub member (not admin)
      mockVerifyGitHubMembership.mockResolvedValueOnce({
        isMember: true,
        role: "member", // Not admin!
      });

      const payload = createInstallationPayload("created", {
        accountType: "Organization",
        senderLogin: "member-installer",
      });

      const res = await makeWebhookRequest("installation", payload);

      expect(res.status).toBe(200);

      // Verify verifyGitHubMembership was called
      expect(mockVerifyGitHubMembership).toHaveBeenCalled();

      // Verify NO owner membership was created for the installer
      // Only the org insert should have happened, NOT a member insert
      const insertCalls = mockValues.mock.calls;
      const memberInsert = insertCalls.find(
        (call) =>
          (call[0] as Record<string, unknown>)?.userId ===
          "existing-detent-user"
      );
      expect(memberInsert).toBeUndefined();
    });

    it("auto-links installer for personal accounts WITHOUT admin verification", async () => {
      // Personal accounts don't have membership - installer is owner by definition
      setQueryResult("organizations:getByProviderAccount", null);
      setQueryResult("organizations:listByProviderInstallationId", []);
      setQueryResult("organizations:getBySlug", null);
      setQueryResult("organization_members:listByProviderUserId", [
        { userId: "existing-detent-user" },
      ]);
      setQueryResult("organization_members:getByOrgUser", null);

      const payload = createInstallationPayload("created", {
        accountType: "User", // Personal account
        accountLogin: "my-personal-account",
        senderLogin: "my-personal-account",
      });

      const res = await makeWebhookRequest("installation", payload);

      expect(res.status).toBe(200);

      // Verify verifyGitHubMembership was NOT called (personal accounts skip verification)
      expect(mockVerifyGitHubMembership).not.toHaveBeenCalled();

      // Verify owner membership WAS created (no admin check needed for personal accounts)
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "existing-detent-user",
          role: "owner",
        })
      );
    });
  });

  describe("idempotency - duplicate installation", () => {
    it("returns success when organization already exists for installation", async () => {
      // Mock existing organization found
      mockLimit.mockResolvedValueOnce([
        {
          _id: "existing-organization-id",
          slug: "existing-organization",
          settings: {},
        },
      ]);

      const payload = createInstallationPayload("created");

      const res = await makeWebhookRequest("installation", payload);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        message: "installation already exists",
        organization_id: "existing-organization-id",
        organization_slug: "existing-organization",
        account: "test-org",
        reactivated: false,
      });

      // Verify no insert was attempted
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe("slug collision handling", () => {
    // Slug collision tests are complex because the optimized generateUniqueSlug
    // uses a single batch query. The basic flow tests above cover the primary path.
    // These tests verify the slug suffix logic works correctly.

    it("appends suffix when slug already exists", async () => {
      setQueryResult("organizations:getByProviderAccount", null);
      setQueryResult("organizations:listByProviderInstallationId", []);
      setQueryResult("organization_members:listByProviderUserId", []);
      queueQueryResult(
        "organizations:getBySlug",
        { _id: "existing-org" },
        null
      );

      const payload = createInstallationPayload("created", {
        accountLogin: "test-org",
      });

      const res = await makeWebhookRequest("installation", payload);
      const json = (await res.json()) as InstallationResponse;

      expect(res.status).toBe(200);
      expect(json.organization_slug).toBe("gh/test-org-1");
    });

    it("increments suffix for multiple collisions", async () => {
      setQueryResult("organizations:getByProviderAccount", null);
      setQueryResult("organizations:listByProviderInstallationId", []);
      setQueryResult("organization_members:listByProviderUserId", []);
      queueQueryResult(
        "organizations:getBySlug",
        { _id: "slug-1" },
        { _id: "slug-2" },
        { _id: "slug-3" },
        null
      );

      const payload = createInstallationPayload("created", {
        accountLogin: "popular-name",
      });

      const res = await makeWebhookRequest("installation", payload);
      const json = (await res.json()) as InstallationResponse;

      expect(res.status).toBe(200);
      expect(json.organization_slug).toBe("gh/popular-name-3");
    });

    it("falls back to UUID suffix after max attempts", async () => {
      setQueryResult("organizations:getByProviderAccount", null);
      setQueryResult("organizations:listByProviderInstallationId", []);
      setQueryResult("organization_members:listByProviderUserId", []);
      queueQueryResult(
        "organizations:getBySlug",
        { _id: "slug-0" },
        { _id: "slug-1" },
        { _id: "slug-2" },
        { _id: "slug-3" },
        { _id: "slug-4" },
        { _id: "slug-5" },
        { _id: "slug-6" },
        { _id: "slug-7" },
        { _id: "slug-8" },
        { _id: "slug-9" },
        { _id: "slug-10" }
      );

      const payload = createInstallationPayload("created", {
        accountLogin: "super-popular",
      });

      const res = await makeWebhookRequest("installation", payload);
      const json = (await res.json()) as InstallationResponse;

      expect(res.status).toBe(200);
      // Falls back to UUID prefix (first 8 chars of mockUUID)
      expect(json.organization_slug).toBe("gh/super-popular-test-uui");
    });
  });

  describe("installation.deleted", () => {
    it("soft-deletes the organization by setting deletedAt", async () => {
      setQueryResult("organizations:listByProviderInstallationId", [
        { _id: "org-123" },
      ]);

      const payload = createInstallationPayload("deleted");

      const res = await makeWebhookRequest("installation", payload);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        message: "installation deleted",
        account: "test-org",
      });

      // Verify update was called with correct fields
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          deletedAt: expect.any(Number),
          updatedAt: expect.any(Number),
        })
      );
    });
  });

  describe("installation.suspend", () => {
    it("marks organization as suspended by setting suspendedAt", async () => {
      setQueryResult("organizations:listByProviderInstallationId", [
        { _id: "org-123" },
      ]);

      const payload = createInstallationPayload("suspend");

      const res = await makeWebhookRequest("installation", payload);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        message: "installation suspended",
        account: "test-org",
      });

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          suspendedAt: expect.any(Number),
          updatedAt: expect.any(Number),
        })
      );
    });
  });

  describe("installation.unsuspend", () => {
    it("clears suspension by setting suspendedAt to null", async () => {
      setQueryResult("organizations:listByProviderInstallationId", [
        { _id: "org-123" },
      ]);

      const payload = {
        action: "unsuspend",
        installation: {
          id: 12_345_678,
          account: {
            id: 98_765_432,
            login: "test-org",
            type: "Organization" as const,
          },
        },
      };

      const res = await makeWebhookRequest("installation", payload);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        message: "installation unsuspended",
        account: "test-org",
      });

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          suspendedAt: null,
          updatedAt: expect.any(Number),
        })
      );
    });
  });

  describe("error handling", () => {
    it("returns 500 on database error with structured response", async () => {
      mockLimit.mockRejectedValueOnce(new Error("Database connection failed"));

      const payload = createInstallationPayload("created");

      const res = await makeWebhookRequest("installation", payload);
      const json = await res.json();

      expect(res.status).toBe(500);
      // Error is classified and includes debugging context
      expect(json).toEqual({
        message: "installation error",
        errorCode: "WEBHOOK_DB_CONNECTION",
        error: "Database connection error",
        hint: "Transient database issue - webhook will be retried automatically",
        deliveryId: "test-delivery-id",
        account: "test-org",
      });
    });
  });

  describe("unknown installation actions", () => {
    it("ignores unknown action types", async () => {
      const payload = {
        action: "some_unknown_action",
        installation: {
          id: 12_345_678,
          account: {
            id: 98_765_432,
            login: "test-org",
            type: "Organization" as const,
          },
        },
      };

      const res = await makeWebhookRequest("installation", payload);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        message: "ignored",
        action: "some_unknown_action",
      });

      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});

describe("webhooks - ping event", () => {
  it("responds to ping with pong and zen", async () => {
    const payload = {
      zen: "Speak like a human.",
      hook_id: 123_456,
    };

    const res = await makeWebhookRequest("ping", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "pong",
      zen: "Speak like a human.",
    });
  });
});

describe("webhooks - repository events", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset all mock implementations first
    mockSelect.mockReset();
    mockFrom.mockReset();
    mockWhere.mockReset();
    mockLimit.mockReset();
    mockUpdate.mockReset();
    mockSet.mockReset();

    // Setup mock chain for select queries - simpler version for these tests
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    // Default: no project found
    mockLimit.mockResolvedValue([]);

    // Setup mock chain for update
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-123", slug: "gh/test-org" },
    ]);
  });

  const createRepositoryPayload = (
    action: "renamed" | "privatized" | "publicized" | "transferred",
    overrides: Partial<{
      repoId: number;
      repoName: string;
      repoFullName: string;
      isPrivate: boolean;
      installationId: number;
    }> = {}
  ) => ({
    action,
    repository: {
      id: overrides.repoId ?? 123_456_789,
      name: overrides.repoName ?? "my-repo",
      full_name: overrides.repoFullName ?? "test-org/my-repo",
      private: overrides.isPrivate ?? false,
    },
    installation: {
      id: overrides.installationId ?? 12_345_678,
    },
  });

  it("updates project when repository is renamed", async () => {
    // Mock finding the existing project
    mockLimit.mockResolvedValueOnce([
      {
        _id: "project-123",
        handle: "old-name",
        providerRepoName: "old-name",
        providerRepoFullName: "test-org/old-name",
        isPrivate: false,
      },
    ]);

    const payload = createRepositoryPayload("renamed", {
      repoName: "new-name",
      repoFullName: "test-org/new-name",
    });

    const res = await makeWebhookRequest("repository", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "repository renamed",
      project_id: "project-123",
      old_name: "test-org/old-name",
      new_name: "test-org/new-name",
    });

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRepoName: "new-name",
        providerRepoFullName: "test-org/new-name",
      })
    );
  });

  it("updates project visibility when repository is privatized", async () => {
    mockLimit.mockResolvedValueOnce([
      {
        _id: "project-123",
        handle: "my-repo",
        providerRepoName: "my-repo",
        providerRepoFullName: "test-org/my-repo",
        isPrivate: false,
      },
    ]);

    const payload = createRepositoryPayload("privatized", { isPrivate: true });

    const res = await makeWebhookRequest("repository", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "repository privatized",
      project_id: "project-123",
      is_private: true,
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        isPrivate: true,
      })
    );
  });

  it("updates project visibility when repository is publicized", async () => {
    mockLimit.mockResolvedValueOnce([
      {
        _id: "project-123",
        handle: "my-repo",
        providerRepoName: "my-repo",
        providerRepoFullName: "test-org/my-repo",
        isPrivate: true,
      },
    ]);

    const payload = createRepositoryPayload("publicized", { isPrivate: false });

    const res = await makeWebhookRequest("repository", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "repository publicized",
      project_id: "project-123",
      is_private: false,
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        isPrivate: false,
      })
    );
  });

  it("returns project not found when repo ID does not match", async () => {
    mockLimit.mockResolvedValueOnce([]);

    const payload = createRepositoryPayload("renamed");

    const res = await makeWebhookRequest("repository", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "project not found",
      repo_id: 123_456_789,
    });

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("ignores repository events without installation ID", async () => {
    const payload = {
      action: "renamed",
      repository: {
        id: 123_456_789,
        name: "my-repo",
        full_name: "test-org/my-repo",
        private: false,
      },
      // No installation field
    };

    const res = await makeWebhookRequest("repository", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "ignored",
      reason: "no installation",
    });
  });
});

describe("webhooks - new_permissions_accepted", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
  });

  it("updates organization updatedAt when permissions are accepted", async () => {
    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-123" },
    ]);

    const payload = {
      action: "new_permissions_accepted",
      installation: {
        id: 12_345_678,
        account: {
          id: 98_765_432,
          login: "test-org",
          type: "Organization" as const,
        },
      },
    };

    const res = await makeWebhookRequest("installation", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "permissions updated",
      account: "test-org",
    });

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        updatedAt: expect.any(Number),
      })
    );
  });
});

describe("webhooks - installation.created with repositories", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });

    const createQueryResult = (result: unknown[] = []) => {
      const queryResult = Promise.resolve(result) as Promise<unknown[]> & {
        limit: ReturnType<typeof vi.fn>;
      };
      queryResult.limit = mockLimit;
      return queryResult;
    };

    mockWhere.mockImplementation(() => createQueryResult([]));
    mockLimit.mockResolvedValue([]);

    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({
      onConflictDoNothing: mockOnConflictDoNothing,
    });
    mockOnConflictDoNothing.mockResolvedValue(undefined);
  });

  it("creates organization with provider-prefixed slug (gh/login)", async () => {
    const payload = {
      action: "created",
      installation: {
        id: 12_345_678,
        account: {
          id: 98_765_432,
          login: "MyOrganization",
          type: "Organization" as const,
          avatar_url: "https://avatars.example.com/u/123",
        },
      },
      sender: {
        id: 11_111_111,
        login: "installer-user",
        type: "User" as const,
      },
      repositories: [],
    };

    const res = await makeWebhookRequest("installation", payload);
    const json = (await res.json()) as InstallationResponse;

    expect(res.status).toBe(200);
    expect(json.organization_slug).toBe("gh/myorganization");
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "gh/myorganization",
        provider: "github",
      })
    );
  });

  it("creates projects for all repositories in payload", async () => {
    const payload = {
      action: "created",
      installation: {
        id: 12_345_678,
        account: {
          id: 98_765_432,
          login: "test-org",
          type: "Organization" as const,
        },
      },
      sender: {
        id: 11_111_111,
        login: "installer-user",
        type: "User" as const,
      },
      repositories: [
        {
          id: 1001,
          name: "repo-one",
          full_name: "test-org/repo-one",
          private: false,
        },
        {
          id: 1002,
          name: "Repo-Two",
          full_name: "test-org/Repo-Two",
          private: true,
        },
        {
          id: 1003,
          name: "REPO-THREE",
          full_name: "test-org/REPO-THREE",
          private: false,
        },
      ],
    };

    const res = await makeWebhookRequest("installation", payload);
    const json = (await res.json()) as InstallationResponse;

    expect(res.status).toBe(200);
    expect(json.projects_created).toBe(3);

    // Verify projects are created with correct values
    expect(mockInsert).toHaveBeenCalledTimes(2); // Once for org, once for projects
    expect(mockValues).toHaveBeenCalledWith([
      expect.objectContaining({
        handle: "repo-one", // lowercase
        providerRepoId: "1001",
        providerRepoName: "repo-one",
        providerRepoFullName: "test-org/repo-one",
        isPrivate: false,
      }),
      expect.objectContaining({
        handle: "repo-two", // lowercase
        providerRepoId: "1002",
        providerRepoName: "Repo-Two", // preserves original case in repo name
        providerRepoFullName: "test-org/Repo-Two",
        isPrivate: true,
      }),
      expect.objectContaining({
        handle: "repo-three", // lowercase
        providerRepoId: "1003",
        providerRepoName: "REPO-THREE",
        providerRepoFullName: "test-org/REPO-THREE",
        isPrivate: false,
      }),
    ]);
  });

  it("creates project handles as lowercase repo names", async () => {
    const payload = {
      action: "created",
      installation: {
        id: 12_345_678,
        account: {
          id: 98_765_432,
          login: "test-org",
          type: "Organization" as const,
        },
      },
      sender: {
        id: 11_111_111,
        login: "installer-user",
        type: "User" as const,
      },
      repositories: [
        {
          id: 1001,
          name: "My-Mixed-Case-Repo",
          full_name: "test-org/My-Mixed-Case-Repo",
          private: false,
        },
      ],
    };

    const res = await makeWebhookRequest("installation", payload);

    expect(res.status).toBe(200);
    expect(mockValues).toHaveBeenCalledWith([
      expect.objectContaining({
        handle: "my-mixed-case-repo",
        providerRepoName: "My-Mixed-Case-Repo",
      }),
    ]);
  });
});

describe("webhooks - installation.deleted data integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-123", slug: "gh/test-org" },
    ]);
  });

  it("soft-deletes organization (sets deletedAt, does not hard delete)", async () => {
    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-123" },
    ]);

    const payload = {
      action: "deleted",
      installation: {
        id: 12_345_678,
        account: {
          id: 98_765_432,
          login: "test-org",
          type: "Organization" as const,
        },
      },
    };

    const res = await makeWebhookRequest("installation", payload);
    const json = (await res.json()) as InstallationResponse;

    expect(res.status).toBe(200);
    expect(json.message).toBe("installation deleted");

    // Verify update (soft-delete) was called, not delete
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: expect.any(Number),
        updatedAt: expect.any(Number),
      })
    );
  });
});

describe("webhooks - repository renamed (critical)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });

    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-123", slug: "gh/test-org" },
    ]);
  });

  it("updates providerRepoName and providerRepoFullName on rename", async () => {
    mockLimit.mockResolvedValueOnce([
      {
        _id: "project-uuid-123",
        handle: "original-handle",
        providerRepoName: "old-repo-name",
        providerRepoFullName: "test-org/old-repo-name",
        isPrivate: false,
      },
    ]);

    const payload = {
      action: "renamed",
      repository: {
        id: 999_888,
        name: "new-repo-name",
        full_name: "test-org/new-repo-name",
        private: false,
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("repository", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "repository renamed",
      project_id: "project-uuid-123",
      old_name: "test-org/old-repo-name",
      new_name: "test-org/new-repo-name",
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRepoName: "new-repo-name",
        providerRepoFullName: "test-org/new-repo-name",
        updatedAt: expect.any(Number),
      })
    );
  });

  it("preserves project handle when repository is renamed (critical)", async () => {
    // User may have customized their project handle - renaming repo should NOT change it
    mockLimit.mockResolvedValueOnce([
      {
        _id: "project-uuid-456",
        handle: "my-custom-handle", // Custom handle that differs from repo name
        providerRepoName: "old-name",
        providerRepoFullName: "test-org/old-name",
        isPrivate: false,
      },
    ]);

    const payload = {
      action: "renamed",
      repository: {
        id: 123_456,
        name: "new-name",
        full_name: "test-org/new-name",
        private: false,
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("repository", payload);

    expect(res.status).toBe(200);

    // The update should NOT include handle - handle must be preserved
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRepoName: "new-name",
        providerRepoFullName: "test-org/new-name",
        updatedAt: expect.any(Number),
      })
    );

    // Verify handle is NOT in the update call
    const setCallArgs = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCallArgs).not.toHaveProperty("handle");
  });

  it("preserves project ID on rename (no data loss)", async () => {
    const existingProjectId = "project-uuid-preserved";

    mockLimit.mockResolvedValueOnce([
      {
        _id: existingProjectId,
        handle: "my-project",
        providerRepoName: "old-name",
        providerRepoFullName: "test-org/old-name",
        isPrivate: false,
      },
    ]);

    const payload = {
      action: "renamed",
      repository: {
        id: 777_888,
        name: "completely-new-name",
        full_name: "test-org/completely-new-name",
        private: false,
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("repository", payload);
    const json = (await res.json()) as RepositoryResponse;

    expect(res.status).toBe(200);
    // Response confirms same project ID was updated
    expect(json.project_id).toBe(existingProjectId);

    // Update was called (not insert - which would create new record)
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("webhooks - repository transferred", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });

    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-123", slug: "gh/test-org" },
    ]);
  });

  it("updates providerRepoFullName on transfer", async () => {
    mockLimit.mockResolvedValueOnce([
      {
        _id: "project-uuid-transfer",
        handle: "my-project",
        providerRepoName: "my-repo",
        providerRepoFullName: "old-org/my-repo",
        isPrivate: false,
      },
    ]);

    const payload = {
      action: "transferred",
      repository: {
        id: 555_666,
        name: "my-repo",
        full_name: "new-org/my-repo", // Transferred to new org
        private: false,
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("repository", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "repository transferred",
      project_id: "project-uuid-transfer",
      new_full_name: "new-org/my-repo",
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRepoFullName: "new-org/my-repo",
        updatedAt: expect.any(Number),
      })
    );
  });

  it("moves project to installation organization after transfer", async () => {
    const originalProjectId = "project-stays-with-org";

    mockLimit.mockResolvedValueOnce([
      {
        _id: originalProjectId,
        handle: "transferred-project",
        providerRepoName: "repo",
        providerRepoFullName: "original-org/repo",
        isPrivate: false,
      },
    ]);

    const payload = {
      action: "transferred",
      repository: {
        id: 111_222,
        name: "repo",
        full_name: "different-org/repo",
        private: false,
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("repository", payload);
    const json = (await res.json()) as RepositoryResponse;

    expect(res.status).toBe(200);
    expect(json.project_id).toBe(originalProjectId);

    // Transfer should move linkage to org resolved from installation
    const setCallArgs = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setCallArgs).toHaveProperty("organizationId", "org-123");
  });
});

describe("webhooks - repository visibility changed", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });

    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-123", slug: "gh/test-org" },
    ]);
  });

  it("updates isPrivate to true when privatized", async () => {
    mockLimit.mockResolvedValueOnce([
      {
        _id: "project-visibility",
        handle: "public-repo",
        providerRepoName: "public-repo",
        providerRepoFullName: "test-org/public-repo",
        isPrivate: false,
      },
    ]);

    const payload = {
      action: "privatized",
      repository: {
        id: 333_444,
        name: "public-repo",
        full_name: "test-org/public-repo",
        private: true,
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("repository", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "repository privatized",
      project_id: "project-visibility",
      is_private: true,
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        isPrivate: true,
        updatedAt: expect.any(Number),
      })
    );
  });

  it("updates isPrivate to false when publicized", async () => {
    mockLimit.mockResolvedValueOnce([
      {
        _id: "project-visibility-2",
        handle: "private-repo",
        providerRepoName: "private-repo",
        providerRepoFullName: "test-org/private-repo",
        isPrivate: true,
      },
    ]);

    const payload = {
      action: "publicized",
      repository: {
        id: 444_555,
        name: "private-repo",
        full_name: "test-org/private-repo",
        private: false,
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("repository", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "repository publicized",
      project_id: "project-visibility-2",
      is_private: false,
    });

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        isPrivate: false,
        updatedAt: expect.any(Number),
      })
    );
  });
});

describe("webhooks - installation_repositories (add/remove)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });

    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({
      onConflictDoNothing: mockOnConflictDoNothing,
    });
    mockOnConflictDoNothing.mockResolvedValue(undefined);

    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  });

  it("creates new projects when repositories are added", async () => {
    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-uuid-123", slug: "gh/test-org", settings: {} },
    ]);

    const payload = {
      action: "added",
      installation: {
        id: 12_345_678,
        account: {
          id: 98_765_432,
          login: "test-org",
          type: "Organization" as const,
        },
      },
      repositories_added: [
        {
          id: 2001,
          name: "new-repo",
          full_name: "test-org/new-repo",
          private: false,
        },
        {
          id: 2002,
          name: "Another-Repo",
          full_name: "test-org/Another-Repo",
          private: true,
        },
      ],
      repositories_removed: [],
    };

    const res = await makeWebhookRequest("installation_repositories", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "installation_repositories processed",
      organization_id: "org-uuid-123",
      organization_slug: "gh/test-org",
      projects_added: 2,
      projects_removed: 0,
    });

    expect(mockValues).toHaveBeenCalledWith([
      expect.objectContaining({
        organizationId: "org-uuid-123",
        handle: "new-repo",
        providerRepoId: "2001",
        providerRepoName: "new-repo",
        isPrivate: false,
      }),
      expect.objectContaining({
        organizationId: "org-uuid-123",
        handle: "another-repo", // lowercase
        providerRepoId: "2002",
        providerRepoName: "Another-Repo",
        isPrivate: true,
      }),
    ]);
  });

  it("soft-deletes projects when repositories are removed (sets removedAt)", async () => {
    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-uuid-456", slug: "gh/test-org", settings: {} },
    ]);

    const payload = {
      action: "removed",
      installation: {
        id: 12_345_678,
        account: {
          id: 98_765_432,
          login: "test-org",
          type: "Organization" as const,
        },
      },
      repositories_added: [],
      repositories_removed: [
        {
          id: 3001,
          name: "removed-repo",
          full_name: "test-org/removed-repo",
          private: false,
        },
        {
          id: 3002,
          name: "also-removed",
          full_name: "test-org/also-removed",
          private: true,
        },
      ],
    };

    const res = await makeWebhookRequest("installation_repositories", payload);
    const json = (await res.json()) as InstallationRepositoriesResponse;

    expect(res.status).toBe(200);
    expect(json.projects_removed).toBe(2);

    // Verify soft-delete (update with removedAt) not hard delete
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        removedAt: expect.any(Number),
      })
    );
  });

  it("handles both added and removed in same event", async () => {
    setQueryResult("organizations:listByProviderInstallationId", [
      { _id: "org-uuid-789", slug: "gh/test-org", settings: {} },
    ]);

    const payload = {
      action: "added",
      installation: {
        id: 12_345_678,
        account: {
          id: 98_765_432,
          login: "test-org",
          type: "Organization" as const,
        },
      },
      repositories_added: [
        {
          id: 4001,
          name: "added-repo",
          full_name: "test-org/added-repo",
          private: false,
        },
      ],
      repositories_removed: [
        {
          id: 4002,
          name: "removed-repo",
          full_name: "test-org/removed-repo",
          private: false,
        },
      ],
    };

    const res = await makeWebhookRequest("installation_repositories", payload);
    const json = (await res.json()) as InstallationRepositoriesResponse;

    expect(res.status).toBe(200);
    expect(json.projects_added).toBe(1);
    expect(json.projects_removed).toBe(1);

    // Both insert (for added) and update (for removed) should be called
    expect(mockInsert).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("returns organization not found when installation has no org", async () => {
    setQueryResult("organizations:listByProviderInstallationId", []); // No org found

    const payload = {
      action: "added",
      installation: {
        id: 99_999_999, // Unknown installation
        account: {
          id: 11_111_111,
          login: "unknown-org",
          type: "Organization" as const,
        },
      },
      repositories_added: [
        {
          id: 5001,
          name: "repo",
          full_name: "unknown-org/repo",
          private: false,
        },
      ],
      repositories_removed: [],
    };

    const res = await makeWebhookRequest("installation_repositories", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "organization not found",
      installation_id: 99_999_999,
    });

    // No insert/update should happen
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockValues).not.toHaveBeenCalled();
  });
});

describe("webhooks - organization events", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  });

  it("updates organization login when GitHub org is renamed", async () => {
    setQueryResult("organizations:getByProviderAccount", {
      _id: "org-uuid-rename",
      slug: "gh/old-org-name",
      providerAccountLogin: "old-org-name",
    });

    const payload = {
      action: "renamed",
      organization: {
        id: 12_345_678,
        login: "new-org-name",
        avatar_url: "https://avatars.example.com/u/12345678",
      },
      changes: {
        login: {
          from: "old-org-name",
        },
      },
      installation: {
        id: 99_999_999,
      },
    };

    const res = await makeWebhookRequest("organization", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "organization renamed",
      organization_id: "org-uuid-rename",
      old_login: "old-org-name",
      new_login: "new-org-name",
      old_slug: "gh/old-org-name",
      new_slug: "gh/new-org-name",
    });

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountLogin: "new-org-name",
        slug: "gh/new-org-name",
        name: "new-org-name",
      })
    );
  });

  it("ignores organization event without installation ID", async () => {
    const payload = {
      action: "renamed",
      organization: {
        id: 12_345_678,
        login: "some-org",
      },
      changes: {
        login: { from: "old-name" },
      },
      // No installation field
    };

    const res = await makeWebhookRequest("organization", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "ignored",
      reason: "no installation",
    });
  });

  it("processes member_added with cache invalidation", async () => {
    const payload = {
      action: "member_added",
      organization: {
        id: 12_345_678,
        login: "some-org",
      },
      installation: {
        id: 99_999_999,
      },
    };

    const res = await makeWebhookRequest("organization", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "organization member_added",
      status: "cache_invalidated",
      memberAdded: false,
      memberDemoted: false,
    });
  });
});

describe("webhooks - installation_target events", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue([]);

    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  });

  it("updates organization login when installation target is renamed", async () => {
    setQueryResult("organizations:getByProviderAccount", {
      _id: "org-uuid-install-target-rename",
      slug: "gh/old-target-name",
      providerAccountLogin: "old-target-name",
    });

    const payload = {
      action: "renamed",
      installation_target: {
        id: 87_654_321,
        login: "new-target-name",
        type: "Organization" as const,
        avatar_url: "https://avatars.example.com/u/87654321",
      },
      changes: {
        login: {
          from: "old-target-name",
        },
      },
    };

    const res = await makeWebhookRequest("installation_target", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "installation target renamed",
      organization_id: "org-uuid-install-target-rename",
      old_login: "old-target-name",
      new_login: "new-target-name",
      old_slug: "gh/old-target-name",
      new_slug: "gh/new-target-name",
    });

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountLogin: "new-target-name",
        slug: "gh/new-target-name",
        name: "new-target-name",
      })
    );
  });
});

describe("webhooks - issue_comment events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores non-created comment actions", async () => {
    const payload = {
      action: "edited",
      comment: {
        id: 12_345,
        body: "@detentsh",
        user: { type: "User", login: "test-user" },
      },
      issue: {
        number: 123,
        pull_request: {},
      },
      repository: {
        full_name: "test-org/test-repo",
        owner: { login: "test-org" },
        name: "test-repo",
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("issue_comment", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "ignored",
      reason: "not created",
    });
  });

  it("ignores comments on issues (not PRs)", async () => {
    const payload = {
      action: "created",
      comment: {
        id: 12_345,
        body: "@detentsh",
        user: { type: "User", login: "test-user" },
      },
      issue: {
        number: 123,
        // No pull_request field = this is an issue, not a PR
      },
      repository: {
        full_name: "test-org/test-repo",
        owner: { login: "test-org" },
        name: "test-repo",
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("issue_comment", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "ignored",
      reason: "not a pull request",
    });
  });

  it("ignores bot comments", async () => {
    const payload = {
      action: "created",
      comment: {
        id: 12_345,
        body: "@detent/cli package was updated",
        user: { type: "Bot", login: "changeset-bot" },
      },
      issue: {
        number: 123,
        pull_request: {},
      },
      repository: {
        full_name: "test-org/test-repo",
        owner: { login: "test-org" },
        name: "test-repo",
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("issue_comment", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "ignored",
      reason: "bot comment",
    });
  });

  it("ignores comments without @detentsh mention", async () => {
    const payload = {
      action: "created",
      comment: {
        id: 12_345,
        body: "This is a regular comment without any mention",
        user: { type: "User", login: "test-user" },
      },
      issue: {
        number: 123,
        pull_request: {},
      },
      repository: {
        full_name: "test-org/test-repo",
        owner: { login: "test-org" },
        name: "test-repo",
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("issue_comment", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "ignored",
      reason: "no @detentsh mention",
    });
  });
});

describe("webhooks - check_suite events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores non-requested check_suite actions", async () => {
    const payload = {
      action: "completed",
      check_suite: {
        head_sha: "abc123def456",
        head_branch: "feature-branch",
        pull_requests: [{ number: 42 }],
      },
      repository: {
        full_name: "test-org/test-repo",
        owner: { login: "test-org" },
        name: "test-repo",
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("check_suite", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "ignored",
      action: "completed",
    });
  });

  it("skips check_suite with automatic_check_runs_disabled", async () => {
    const payload = {
      action: "requested",
      check_suite: {
        head_sha: "abc123def456",
        head_branch: "main",
        pull_requests: [], // No PR associated
      },
      repository: {
        full_name: "test-org/test-repo",
        owner: { login: "test-org" },
        name: "test-repo",
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("check_suite", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "skipped",
      reason: "automatic_check_runs_disabled",
    });
  });
});

describe("webhooks - workflow_run events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores non-handled workflow_run actions", async () => {
    const payload = {
      action: "requested",
      workflow_run: {
        id: 12_345,
        name: "CI",
        head_sha: "abc123",
        head_branch: "feature",
        conclusion: null,
        pull_requests: [],
      },
      repository: {
        full_name: "test-org/test-repo",
        owner: { login: "test-org" },
        name: "test-repo",
      },
      installation: { id: 12_345_678 },
    };

    const res = await makeWebhookRequest("workflow_run", payload);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      message: "ignored",
      reason: "action requested not handled",
    });
  });
});

describe("webhooks - organization member events", () => {
  const mockKvDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockKvDelete.mockResolvedValue(undefined);
  });

  const MOCK_ENV_WITH_KV = createMockEnv({
    ...MOCK_ENV,
    "detent-idempotency": {
      ...createMockKv(),
      delete: mockKvDelete,
    },
  });

  describe("ignored actions", () => {
    it("ignores member_invited action", async () => {
      const payload = {
        action: "member_invited",
        organization: {
          id: 98_765_432,
          login: "test-org",
        },
        membership: {
          user: {
            id: 11_111_111,
            login: "test-member",
          },
          role: "member",
        },
        installation: { id: 12_345_678 },
      };

      const res = await app.request(
        "/github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-GitHub-Event": "organization",
            "X-GitHub-Delivery": "test-delivery-id",
            "X-Hub-Signature-256": "sha256=mocked",
          },
          body: JSON.stringify(payload),
        },
        MOCK_ENV_WITH_KV
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      // Non-handled actions return "ignored" with the action name
      expect(json).toEqual({ message: "ignored", action: "member_invited" });
    });

    it("ignores organization event without installation ID", async () => {
      const payload = {
        action: "member_added",
        organization: {
          id: 98_765_432,
          login: "test-org",
        },
        membership: {
          user: {
            id: 11_111_111,
            login: "test-member",
          },
          role: "member",
        },
        // No installation field
      };

      const res = await app.request(
        "/github",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-GitHub-Event": "organization",
            "X-GitHub-Delivery": "test-delivery-id",
            "X-Hub-Signature-256": "sha256=mocked",
          },
          body: JSON.stringify(payload),
        },
        MOCK_ENV_WITH_KV
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({ message: "ignored", reason: "no installation" });
    });
  });
});
