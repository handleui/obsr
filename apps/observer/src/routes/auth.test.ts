import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEnv } from "../test-helpers/mock-env";
import type { Env } from "../types/env";

const mockQuery = vi.fn();
const mockMutation = vi.fn();
const mockPoolQuery = vi.fn();

const mockDB = {
  query: mockQuery,
  mutation: mockMutation,
};

const mockPool = {
  query: mockPoolQuery,
};

vi.mock("../db/client", () => ({
  getDbClient: vi.fn(() => mockDB),
}));

vi.mock("../lib/better-auth", () => ({
  getBetterAuthPool: vi.fn(() => mockPool),
}));

const mockFetch = vi.fn();

const DEFAULT_MOCK_ENV = createMockEnv({});

const makeRequest = async (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
  env: Env = DEFAULT_MOCK_ENV
): Promise<Response> => {
  const authRoutes = (await import("./auth")).default;

  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    c.set("auth" as never, { userId: "user-123" } as never);
    await next();
  });

  app.route("/auth", authRoutes);

  const options: RequestInit = {
    method,
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  return app.request(path, options, env);
};

const createBetterAuthUser = (
  overrides: Partial<{
    id: string;
    email: string;
    name: string | null;
  }> = {}
) => ({
  id: overrides.id ?? "user-123",
  email: overrides.email ?? "test@example.com",
  name: "name" in overrides ? overrides.name : "Test User",
});

const installDefaultPoolMocks = () => {
  mockPoolQuery.mockImplementation((queryText: string) => {
    if (queryText.includes('FROM "user"')) {
      return Promise.resolve({ rows: [createBetterAuthUser()] });
    }

    if (queryText.includes("FROM account")) {
      return Promise.resolve({
        rows: [{ account_id: "12345", access_token: null }],
      });
    }

    return Promise.resolve({ rows: [] });
  });
};

const VALID_GITHUB_TOKEN = `gho_${"a".repeat(40)}`;
const VALID_GITHUB_REFRESH_TOKEN = `ghr_${"b".repeat(30)}`;

const createGitHubUserResponse = (
  user: { id: number; login: string } = { id: 12_345, login: "testuser" }
) => ({
  ok: true,
  headers: {
    get: (name: string) =>
      name.toLowerCase() === "x-oauth-scopes" ? "read:org,user:email" : null,
  },
  json: () => Promise.resolve(user),
});

describe("auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockQuery.mockReset();
    mockMutation.mockReset();
    mockPoolQuery.mockReset();

    installDefaultPoolMocks();

    mockQuery.mockImplementation((name: string) => {
      if (name === "organization_members:listByUser") {
        return Promise.resolve([]);
      }
      if (name === "organizations:listByInstallerGithubId") {
        return Promise.resolve([]);
      }
      if (name === "organization_members:getByOrgUser") {
        return Promise.resolve(null);
      }
      if (name === "organizations:listByProviderAccountIds") {
        return Promise.resolve([]);
      }
      if (name === "organizations:getById") {
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    });

    global.fetch = mockFetch;
  });

  describe("POST /auth/sync-user", () => {
    it("syncs identity with Better Auth linked GitHub account", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 12_345, login: "testuser" }),
      });

      mockQuery.mockImplementation((name: string) => {
        if (name === "organization_members:listByUser") {
          return Promise.resolve([
            {
              _id: "member-1",
              organizationId: "organization-1",
              userId: "user-123",
              role: "member",
            },
            {
              _id: "member-2",
              organizationId: "organization-2",
              userId: "user-123",
              role: "member",
            },
          ]);
        }
        if (name === "organizations:listByInstallerGithubId") {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const res = await makeRequest("POST", "/auth/sync-user");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        user_id: "user-123",
        email: "test@example.com",
        first_name: "Test",
        last_name: "User",
        github_synced: true,
        github_user_id: "12345",
        github_username: "testuser",
        organizations_updated: 2,
        installer_orgs_linked: 0,
        github_orgs_joined: 0,
      });
      expect(mockMutation).toHaveBeenCalled();
    });

    it("returns user info when no GitHub account is linked", async () => {
      mockPoolQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM "user"')) {
          return Promise.resolve({ rows: [createBetterAuthUser()] });
        }

        if (queryText.includes("FROM account")) {
          return Promise.resolve({ rows: [] });
        }

        return Promise.resolve({ rows: [] });
      });

      const res = await makeRequest("POST", "/auth/sync-user");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        user_id: "user-123",
        email: "test@example.com",
        first_name: "Test",
        last_name: "User",
        github_synced: false,
        github_username: null,
      });
      expect(mockMutation).not.toHaveBeenCalled();
    });

    it("syncs identity with null username when GitHub user lookup fails", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: false });

      mockQuery.mockImplementation((name: string) => {
        if (name === "organization_members:listByUser") {
          return Promise.resolve([
            {
              _id: "member-1",
              organizationId: "organization-1",
              userId: "user-123",
              role: "member",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await makeRequest("POST", "/auth/sync-user");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toMatchObject({
        github_synced: true,
        github_user_id: "12345",
        github_username: null,
        organizations_updated: 1,
      });
    });

    it("returns 500 when Better Auth user fetch fails", async () => {
      mockPoolQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM "user"')) {
          return Promise.resolve({ rows: [] });
        }

        if (queryText.includes("FROM account")) {
          return Promise.resolve({ rows: [{ account_id: "12345" }] });
        }

        return Promise.resolve({ rows: [] });
      });

      const res = await makeRequest("POST", "/auth/sync-user");
      const json = await res.json();

      expect(res.status).toBe(500);
      expect(json).toEqual({ error: "Failed to fetch user details" });
    });
  });

  describe("GET /auth/me", () => {
    it("returns user info with GitHub linked membership", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organization_members:listByUser") {
          return Promise.resolve([
            {
              _id: "member-1",
              organizationId: "organization-1",
              userId: "user-123",
              providerUserId: "12345",
              providerUsername: "testuser",
              role: "member",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const res = await makeRequest("GET", "/auth/me");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        user_id: "user-123",
        email: "test@example.com",
        first_name: "Test",
        last_name: "User",
        github_linked: true,
        github_user_id: "12345",
        github_username: "testuser",
      });
    });

    it("falls back to linked account when membership is not linked", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organization_members:listByUser") {
          return Promise.resolve([
            {
              _id: "member-1",
              organizationId: "organization-1",
              userId: "user-123",
              providerUserId: null,
              providerUsername: null,
              role: "member",
            },
          ]);
        }
        return Promise.resolve([]);
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 12_345, login: "testuser" }),
      });

      const res = await makeRequest("GET", "/auth/me");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        user_id: "user-123",
        email: "test@example.com",
        first_name: "Test",
        last_name: "User",
        github_linked: true,
        github_user_id: "12345",
        github_username: "testuser",
      });
    });

    it("returns user info without GitHub linked", async () => {
      mockPoolQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM "user"')) {
          return Promise.resolve({ rows: [createBetterAuthUser()] });
        }

        if (queryText.includes("FROM account")) {
          return Promise.resolve({ rows: [] });
        }

        return Promise.resolve({ rows: [] });
      });

      const res = await makeRequest("GET", "/auth/me");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json).toEqual({
        user_id: "user-123",
        email: "test@example.com",
        first_name: "Test",
        last_name: "User",
        github_linked: false,
        github_user_id: null,
        github_username: null,
      });
    });

    it("returns 500 when Better Auth user fetch fails", async () => {
      mockPoolQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM "user"')) {
          return Promise.resolve({ rows: [] });
        }

        if (queryText.includes("FROM account")) {
          return Promise.resolve({ rows: [{ account_id: "12345" }] });
        }

        return Promise.resolve({ rows: [] });
      });

      const res = await makeRequest("GET", "/auth/me");
      const json = await res.json();

      expect(res.status).toBe(500);
      expect(json).toEqual({ error: "Failed to fetch user details" });
    });

    it("handles user without first/last name", async () => {
      mockPoolQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM "user"')) {
          return Promise.resolve({
            rows: [
              createBetterAuthUser({
                id: "user-123",
                email: "test@example.com",
                name: null,
              }),
            ],
          });
        }

        if (queryText.includes("FROM account")) {
          return Promise.resolve({ rows: [] });
        }

        return Promise.resolve({ rows: [] });
      });

      const res = await makeRequest("GET", "/auth/me");
      const json = (await res.json()) as {
        first_name?: string;
        last_name?: string;
      };

      expect(res.status).toBe(200);
      expect(json.first_name).toBeUndefined();
      expect(json.last_name).toBeUndefined();
    });
  });

  describe("GET /auth/github-orgs", () => {
    it("returns github_account_not_linked when token is provided without linked account", async () => {
      mockPoolQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM "user"')) {
          return Promise.resolve({ rows: [createBetterAuthUser()] });
        }

        if (queryText.includes("FROM account")) {
          return Promise.resolve({ rows: [] });
        }

        return Promise.resolve({ rows: [] });
      });

      mockFetch.mockResolvedValueOnce(createGitHubUserResponse());

      const res = await makeRequest("GET", "/auth/github-orgs", undefined, {
        "X-GitHub-Token": VALID_GITHUB_TOKEN,
      });
      const json = (await res.json()) as { error: string; code?: string };

      expect(res.status).toBe(401);
      expect(json.code).toBe("github_account_not_linked");
    });

    it("falls back to linked Better Auth account token when header is missing", async () => {
      mockPoolQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM "user"')) {
          return Promise.resolve({ rows: [createBetterAuthUser()] });
        }

        if (queryText.includes("FROM account")) {
          return Promise.resolve({
            rows: [{ account_id: "12345", access_token: VALID_GITHUB_TOKEN }],
          });
        }

        return Promise.resolve({ rows: [] });
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: () => null,
        },
        json: () => Promise.resolve([]),
      });

      const res = await makeRequest("GET", "/auth/github-orgs");
      const json = (await res.json()) as { orgs: unknown[] };

      expect(res.status).toBe(200);
      expect(json.orgs).toEqual([]);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("https://api.github.com/user/orgs"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${VALID_GITHUB_TOKEN}`,
          }),
        })
      );
    });
  });

  describe("POST /auth/github-token/refresh", () => {
    it("returns github_account_not_linked when token refresh succeeds but account is not linked", async () => {
      const env = createMockEnv({
        GITHUB_CLIENT_SECRET: "github-client-secret",
      });

      mockPoolQuery.mockImplementation((queryText: string) => {
        if (queryText.includes('FROM "user"')) {
          return Promise.resolve({ rows: [createBetterAuthUser()] });
        }

        if (queryText.includes("FROM account")) {
          return Promise.resolve({ rows: [] });
        }

        return Promise.resolve({ rows: [] });
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: VALID_GITHUB_TOKEN,
              expires_in: 3600,
              refresh_token: VALID_GITHUB_REFRESH_TOKEN,
              refresh_token_expires_in: 86_400,
              scope: "read:org,user:email",
              token_type: "bearer",
            }),
        })
        .mockResolvedValueOnce(createGitHubUserResponse());

      const res = await makeRequest(
        "POST",
        "/auth/github-token/refresh",
        { refresh_token: VALID_GITHUB_REFRESH_TOKEN },
        undefined,
        env
      );
      const json = (await res.json()) as { error: string; code?: string };

      expect(res.status).toBe(401);
      expect(json.code).toBe("github_account_not_linked");
    });
  });
});
