import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEnv } from "../test-helpers/mock-env";

interface Organization {
  _id: string;
  name: string;
  slug: string;
  enterpriseId: string | null;
  provider: "github" | "gitlab";
  providerAccountId: string;
  providerAccountLogin: string;
  providerAccountType: "organization" | "user";
  providerAvatarUrl: string | null;
  providerInstallationId: string | null;
  providerAccessTokenEncrypted: string | null;
  providerAccessTokenExpiresAt: number | null;
  providerWebhookSecret: string | null;
  installerGithubId: string | null;
  suspendedAt: Date | null;
  deletedAt: Date | null;
  lastSyncedAt: Date | null;
  settings: Record<string, unknown>;
  polarCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface OrganizationMember {
  _id: string;
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "visitor";
  providerUserId: string | null;
  providerUsername: string | null;
  providerLinkedAt: Date | null;
  providerVerifiedAt: Date | null;
  membershipSource: string | null;
  removedAt: Date | null;
  removalReason: string | null;
  removedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Separate mocks for each table
const mockOrgFindFirst = vi.fn();
const mockMemberFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockInsert = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn();
const mockValues = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockReturning = vi.fn();

const mockQuery = vi.fn();
const mockMutation = vi.fn();
const mockConvex = { query: mockQuery, mutation: mockMutation };

vi.mock("../db/convex", () => ({
  getConvexClient: vi.fn(() => mockConvex),
}));

// Mock GitHub identity verification
const mockGetVerifiedGitHubIdentity = vi.fn();
vi.mock("../lib/github-identity", () => ({
  getVerifiedGitHubIdentity: (...args: unknown[]) =>
    mockGetVerifiedGitHubIdentity(...args),
}));

// Mock GitHub membership verification
const mockVerifyGitHubMembership = vi.fn();
vi.mock("../lib/github-membership", () => ({
  verifyGitHubMembership: (...args: unknown[]) =>
    mockVerifyGitHubMembership(...args),
}));

// Factory helpers
const createOrg = (overrides: Partial<Organization> = {}): Organization => ({
  _id: "org-123",
  name: "Test Org",
  slug: "gh/test-org",
  enterpriseId: null,
  provider: "github",
  providerAccountId: "123456",
  providerAccountLogin: "test-org",
  providerAccountType: "organization",
  providerAvatarUrl: null,
  providerInstallationId: "inst-789",
  providerAccessTokenEncrypted: null,
  providerAccessTokenExpiresAt: null,
  providerWebhookSecret: null,
  installerGithubId: "installer-999",
  suspendedAt: null,
  deletedAt: null,
  lastSyncedAt: null,
  settings: {},
  polarCustomerId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createMember = (
  overrides: Partial<OrganizationMember> = {}
): OrganizationMember => ({
  _id: "member-123",
  organizationId: "org-123",
  userId: "user-abc",
  role: "member",
  providerUserId: "gh-user-456",
  providerUsername: "testuser",
  providerLinkedAt: new Date(),
  providerVerifiedAt: null,
  membershipSource: null,
  removedAt: null,
  removalReason: null,
  removedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const MOCK_ENV = createMockEnv({
  WORKOS_API_KEY: "sk_test_workos_key",
  WORKOS_CLIENT_ID: "client_123",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "key",
});

describe("github-org-access middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockWhere.mockResolvedValue([]);
    // Set up insert chain: db.insert().values().onConflictDoNothing().returning()
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({
      onConflictDoNothing: mockOnConflictDoNothing,
    });
    mockOnConflictDoNothing.mockReturnValue({ returning: mockReturning });
    // Default: insert succeeds (returns inserted row)
    mockReturning.mockResolvedValue([{ _id: "new-member-id", role: "member" }]);
    // Set up select chain: db.select().from().where()
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockSelectWhere });
    // Default: org has owners (count: 1)
    mockSelectWhere.mockResolvedValue([{ count: 1 }]);

    mockQuery.mockReset();
    mockMutation.mockReset();

    const resolveOwners = async (): Promise<OrganizationMember[]> => {
      const result = await mockSelectWhere();
      if (
        Array.isArray(result) &&
        result.length > 0 &&
        typeof (result[0] as { count?: number }).count === "number"
      ) {
        const count = (result[0] as { count: number }).count;
        return Array.from({ length: count }, (_, index) => ({
          _id: `owner-${index}`,
          organizationId: "org-123",
          userId: `user-${index}`,
          role: "owner",
          providerUserId: null,
          providerUsername: null,
          providerLinkedAt: null,
          providerVerifiedAt: null,
          membershipSource: null,
          removedAt: null,
          removalReason: null,
          removedBy: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));
      }
      return (result as OrganizationMember[]) ?? [];
    };

    mockQuery.mockImplementation(async (name: string) => {
      if (
        name === "organizations:getById" ||
        name === "organizations:getBySlug"
      ) {
        return await mockOrgFindFirst();
      }
      if (name === "organization-members:getByOrgUser") {
        return await mockMemberFindFirst();
      }
      if (name === "organization-members:listByOrgRole") {
        return await resolveOwners();
      }
      return [];
    });

    mockMutation.mockImplementation(
      async (name: string, args: Record<string, unknown>) => {
        if (name === "organization-members:update") {
          mockUpdate();
          return null;
        }
        if (name === "organization-members:createIfMissing") {
          mockInsert();
          mockValues(args);
          const returning = await mockReturning();
          return Array.isArray(returning) ? returning[0] : returning;
        }
        return null;
      }
    );
  });

  describe("seedRoleFromGitHub - role seeding for new members", () => {
    // We test the role seeding logic by verifying what role gets inserted
    // when a new member is created

    it("installer with GitHub member role gets member role (no special privileges)", async () => {
      // Security: installer is tracked but does NOT get automatic owner privileges
      // Only GitHub admins can become owners/admins
      const org = createOrg({ installerGithubId: "installer-999" });

      mockOrgFindFirst.mockResolvedValue(org);
      mockMemberFindFirst.mockResolvedValue(undefined); // No existing member

      mockGetVerifiedGitHubIdentity.mockResolvedValue({
        userId: "installer-999",
        username: "installer-user",
      });

      mockVerifyGitHubMembership.mockResolvedValue({
        isMember: true,
        role: "member", // GitHub says "member"
      });

      const { githubOrgAccessMiddleware } = await import("./github-org-access");
      const { Hono } = await import("hono");
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("auth" as never, { userId: "user-abc" } as never);
        await next();
      });
      app.use("/orgs/:orgId/*", githubOrgAccessMiddleware);
      app.get("/orgs/:orgId/test", (c) => {
        const orgAccess = c.get("orgAccess");
        return c.json({ role: orgAccess.role });
      });

      const res = await app.request("/orgs/org-123/test", {}, MOCK_ENV);
      const json = (await res.json()) as { role: string };

      expect(res.status).toBe(200);
      expect(json.role).toBe("member"); // No installer privilege bypass

      // Verify role was seeded as "member" in the insert
      expect(mockInsert).toHaveBeenCalled();
      const insertCall = mockValues.mock.calls[0]?.[0] as { role: string };
      expect(insertCall.role).toBe("member");
    });

    it("GitHub admin gets admin role when not installer", async () => {
      const org = createOrg({ installerGithubId: "someone-else" });

      mockOrgFindFirst.mockResolvedValue(org);
      mockMemberFindFirst.mockResolvedValue(undefined);

      mockGetVerifiedGitHubIdentity.mockResolvedValue({
        userId: "admin-user-id",
        username: "admin-user",
      });

      mockVerifyGitHubMembership.mockResolvedValue({
        isMember: true,
        role: "admin",
      });

      const { githubOrgAccessMiddleware } = await import("./github-org-access");
      const { Hono } = await import("hono");
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("auth" as never, { userId: "user-abc" } as never);
        await next();
      });
      app.use("/orgs/:orgId/*", githubOrgAccessMiddleware);
      app.get("/orgs/:orgId/test", (c) => {
        const orgAccess = c.get("orgAccess");
        return c.json({ role: orgAccess.role });
      });

      const res = await app.request("/orgs/org-123/test", {}, MOCK_ENV);
      const json = (await res.json()) as { role: string };

      expect(res.status).toBe(200);
      expect(json.role).toBe("admin");

      const insertCall = mockValues.mock.calls[0]?.[0] as { role: string };
      expect(insertCall.role).toBe("admin");
    });

    it("first GitHub admin on ownerless org becomes owner", async () => {
      const org = createOrg({ installerGithubId: "someone-else" });

      mockOrgFindFirst.mockResolvedValue(org);
      mockMemberFindFirst.mockResolvedValue(undefined);
      // Org has no owners
      mockSelectWhere.mockResolvedValue([{ count: 0 }]);

      mockGetVerifiedGitHubIdentity.mockResolvedValue({
        userId: "first-admin-id",
        username: "first-admin",
      });

      mockVerifyGitHubMembership.mockResolvedValue({
        isMember: true,
        role: "admin",
      });

      const { githubOrgAccessMiddleware } = await import("./github-org-access");
      const { Hono } = await import("hono");
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("auth" as never, { userId: "user-abc" } as never);
        await next();
      });
      app.use("/orgs/:orgId/*", githubOrgAccessMiddleware);
      app.get("/orgs/:orgId/test", (c) => {
        const orgAccess = c.get("orgAccess");
        return c.json({ role: orgAccess.role });
      });

      const res = await app.request("/orgs/org-123/test", {}, MOCK_ENV);
      const json = (await res.json()) as { role: string };

      expect(res.status).toBe(200);
      expect(json.role).toBe("owner"); // First admin becomes owner

      const insertCall = mockValues.mock.calls[0]?.[0] as { role: string };
      expect(insertCall.role).toBe("owner");
    });

    it("GitHub member gets member role", async () => {
      const org = createOrg({ installerGithubId: "someone-else" });

      mockOrgFindFirst.mockResolvedValue(org);
      mockMemberFindFirst.mockResolvedValue(undefined);

      mockGetVerifiedGitHubIdentity.mockResolvedValue({
        userId: "regular-user-id",
        username: "regular-user",
      });

      mockVerifyGitHubMembership.mockResolvedValue({
        isMember: true,
        role: "member",
      });

      const { githubOrgAccessMiddleware } = await import("./github-org-access");
      const { Hono } = await import("hono");
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("auth" as never, { userId: "user-abc" } as never);
        await next();
      });
      app.use("/orgs/:orgId/*", githubOrgAccessMiddleware);
      app.get("/orgs/:orgId/test", (c) => {
        const orgAccess = c.get("orgAccess");
        return c.json({ role: orgAccess.role });
      });

      const res = await app.request("/orgs/org-123/test", {}, MOCK_ENV);
      const json = (await res.json()) as { role: string };

      expect(res.status).toBe(200);
      expect(json.role).toBe("member");

      const insertCall = mockValues.mock.calls[0]?.[0] as { role: string };
      expect(insertCall.role).toBe("member");
    });
  });

  describe("role decoupling - existing members use DB role", () => {
    it("existing admin keeps admin role even if GitHub says member", async () => {
      const org = createOrg();
      const member = createMember({ role: "admin" });

      mockOrgFindFirst.mockResolvedValue(org);
      mockMemberFindFirst.mockResolvedValue(member);

      mockGetVerifiedGitHubIdentity.mockResolvedValue({
        userId: "gh-user-456",
        username: "testuser",
      });

      mockVerifyGitHubMembership.mockResolvedValue({
        isMember: true,
        role: "member", // GitHub downgraded to member
      });

      const { githubOrgAccessMiddleware } = await import("./github-org-access");
      const { Hono } = await import("hono");
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("auth" as never, { userId: "user-abc" } as never);
        await next();
      });
      app.use("/orgs/:orgId/*", githubOrgAccessMiddleware);
      app.get("/orgs/:orgId/test", (c) => {
        const orgAccess = c.get("orgAccess");
        return c.json({ role: orgAccess.role });
      });

      const res = await app.request("/orgs/org-123/test", {}, MOCK_ENV);
      const json = (await res.json()) as { role: string };

      expect(res.status).toBe(200);
      expect(json.role).toBe("admin"); // DB role preserved

      // No insert should happen - member already exists
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("existing member keeps member role even if GitHub says admin", async () => {
      const org = createOrg();
      const member = createMember({ role: "member" });

      mockOrgFindFirst.mockResolvedValue(org);
      mockMemberFindFirst.mockResolvedValue(member);

      mockGetVerifiedGitHubIdentity.mockResolvedValue({
        userId: "gh-user-456",
        username: "testuser",
      });

      mockVerifyGitHubMembership.mockResolvedValue({
        isMember: true,
        role: "admin", // GitHub upgraded to admin
      });

      const { githubOrgAccessMiddleware } = await import("./github-org-access");
      const { Hono } = await import("hono");
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("auth" as never, { userId: "user-abc" } as never);
        await next();
      });
      app.use("/orgs/:orgId/*", githubOrgAccessMiddleware);
      app.get("/orgs/:orgId/test", (c) => {
        const orgAccess = c.get("orgAccess");
        return c.json({ role: orgAccess.role });
      });

      const res = await app.request("/orgs/org-123/test", {}, MOCK_ENV);
      const json = (await res.json()) as { role: string };

      expect(res.status).toBe(200);
      expect(json.role).toBe("member"); // DB role preserved, not GitHub

      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("existing visitor keeps visitor role regardless of GitHub role", async () => {
      // Visitor role is manually assigned and persists even if GitHub says admin
      const org = createOrg();
      const member = createMember({ role: "visitor" });

      mockOrgFindFirst.mockResolvedValue(org);
      mockMemberFindFirst.mockResolvedValue(member);

      mockGetVerifiedGitHubIdentity.mockResolvedValue({
        userId: "gh-user-456",
        username: "testuser",
      });

      mockVerifyGitHubMembership.mockResolvedValue({
        isMember: true,
        role: "admin", // GitHub says admin
      });

      const { githubOrgAccessMiddleware } = await import("./github-org-access");
      const { Hono } = await import("hono");
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("auth" as never, { userId: "user-abc" } as never);
        await next();
      });
      app.use("/orgs/:orgId/*", githubOrgAccessMiddleware);
      app.get("/orgs/:orgId/test", (c) => {
        const orgAccess = c.get("orgAccess");
        return c.json({ role: orgAccess.role });
      });

      const res = await app.request("/orgs/org-123/test", {}, MOCK_ENV);
      const json = (await res.json()) as { role: string };

      expect(res.status).toBe(200);
      expect(json.role).toBe("visitor"); // DB role preserved

      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe("access control - membership trust model", () => {
    it("existing members retain access without re-checking GitHub (to handle missing members:read permission)", async () => {
      // Existing members trust DB role - GitHub membership is NOT re-verified on each request
      // This handles the case where GitHub App lacks members:read permission
      const org = createOrg();
      const member = createMember({ role: "admin" });

      mockOrgFindFirst.mockResolvedValue(org);
      mockMemberFindFirst.mockResolvedValue(member);

      mockGetVerifiedGitHubIdentity.mockResolvedValue({
        userId: "gh-user-456",
        username: "testuser",
      });

      // GitHub membership check is NOT called for existing members
      // If it were, this would return false - but it's not called

      const { githubOrgAccessMiddleware } = await import("./github-org-access");
      const { Hono } = await import("hono");
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("auth" as never, { userId: "user-abc" } as never);
        await next();
      });
      app.use("/orgs/:orgId/*", githubOrgAccessMiddleware);
      app.get("/orgs/:orgId/test", (c) => {
        const orgAccess = c.get("orgAccess");
        return c.json({ role: orgAccess.role });
      });

      const res = await app.request("/orgs/org-123/test", {}, MOCK_ENV);
      const json = (await res.json()) as { role: string };

      expect(res.status).toBe(200);
      expect(json.role).toBe("admin"); // DB role is trusted
      expect(mockVerifyGitHubMembership).not.toHaveBeenCalled(); // Membership not re-checked
    });

    it("new users without GitHub membership are denied access", async () => {
      const org = createOrg();

      mockOrgFindFirst.mockResolvedValue(org);
      mockMemberFindFirst.mockResolvedValue(undefined); // No existing membership

      mockGetVerifiedGitHubIdentity.mockResolvedValue({
        userId: "new-user-id",
        username: "newuser",
      });

      mockVerifyGitHubMembership.mockResolvedValue({
        isMember: false, // Not a GitHub org member
        role: null,
      });

      const { githubOrgAccessMiddleware } = await import("./github-org-access");
      const { Hono } = await import("hono");
      const app = new Hono();

      app.use("*", async (c, next) => {
        c.set("auth" as never, { userId: "user-xyz" } as never);
        await next();
      });
      app.use("/orgs/:orgId/*", githubOrgAccessMiddleware);
      app.get("/orgs/:orgId/test", (c) => c.json({ ok: true }));

      const res = await app.request("/orgs/org-123/test", {}, MOCK_ENV);
      const json = (await res.json()) as { error: string };

      expect(res.status).toBe(403);
      expect(json.error).toBe("Access denied");
    });
  });
});
