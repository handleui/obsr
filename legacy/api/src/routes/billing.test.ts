import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEnv } from "../test-helpers/mock-env";
import type { Env } from "../types/env";

const mockQuery = vi.fn();
const mockMutation = vi.fn();
const mockDB = { query: mockQuery, mutation: mockMutation };

vi.mock("../db/client", () => ({
  getDbClient: vi.fn(() => mockDB),
}));

// Mock polar services
const mockCreatePolarClient = vi.fn();
const mockGetPolarOrgId = vi.fn();
const mockCreatePolarCustomer = vi.fn();
const mockCreateCustomerPortalSession = vi.fn();

vi.mock("../services/polar", () => ({
  createPolarClient: (...args: unknown[]) => mockCreatePolarClient(...args),
  getPolarOrgId: (...args: unknown[]) => mockGetPolarOrgId(...args),
  createPolarCustomer: (...args: unknown[]) => mockCreatePolarCustomer(...args),
  createCustomerPortalSession: (...args: unknown[]) =>
    mockCreateCustomerPortalSession(...args),
}));

// Mock billing services
vi.mock("../services/billing", () => ({
  getUsageSummary: vi.fn().mockResolvedValue({ runs: 0 }),
  getCreditUsageSummary: vi.fn().mockResolvedValue({ credits: 0 }),
}));

// Mock the middleware - inject orgAccess directly for testing route logic
vi.mock("../middleware/github-org-access", () => ({
  githubOrgAccessMiddleware: vi.fn(async (_c, next) => {
    await next();
  }),
  requireRole: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  }),
}));

// Mock environment
const MOCK_ENV = createMockEnv({
  POLAR_ACCESS_TOKEN: "polar_test_token",
  POLAR_ORGANIZATION_ID: "polar-org-123",
});

// Factory for org access context
const createOrgAccessContext = (overrides: Partial<{ _id: string }> = {}) => ({
  organization: {
    _id: overrides._id ?? "org-123",
    slug: "test-org",
    name: "Test Org",
    provider: "github" as const,
    providerAccountLogin: "test-org",
    providerAccountType: "organization" as const,
    providerInstallationId: "123456",
    installerGithubId: "user-123",
    settings: {},
  },
  githubIdentity: {
    userId: "gh-user-123",
    username: "testuser",
  },
  role: "owner" as const,
});

// Helper to make request with a fresh app instance
const makeRequest = async (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  orgAccess = createOrgAccessContext()
): Promise<Response> => {
  const billingRoutes = (await import("./billing")).default;

  const app = new Hono<{ Bindings: Env }>();

  // Middleware to set orgAccess context (simulating what githubOrgAccessMiddleware does)
  app.use("*", async (c, next) => {
    c.set("orgAccess" as never, orgAccess as never);
    await next();
  });

  app.route("/billing", billingRoutes);

  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (body !== undefined) {
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return app.request(path, options, MOCK_ENV);
};

describe("billing routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockMutation.mockReset();
    mockCreatePolarClient.mockReturnValue({});
    mockGetPolarOrgId.mockReturnValue("polar-org-123");

    mockQuery.mockImplementation((name: string) => {
      if (name === "organizations:getById") {
        return Promise.resolve({ _id: "org-123", polarCustomerId: null });
      }
      return Promise.resolve([]);
    });
  });

  // ============================================================================
  // POST /:orgId/customer - Input Validation
  // ============================================================================

  describe("POST /:orgId/customer - input validation", () => {
    it("rejects invalid JSON body", async () => {
      const billingRoutes = (await import("./billing")).default;
      const app = new Hono<{ Bindings: Env }>();

      app.use("*", async (c, next) => {
        c.set("orgAccess" as never, createOrgAccessContext() as never);
        await next();
      });
      app.route("/billing", billingRoutes);

      const res = await app.request(
        "/billing/org-123/customer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not valid json{",
        },
        MOCK_ENV
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    });

    it("rejects array as body", async () => {
      const res = await makeRequest("POST", "/billing/org-123/customer", [
        "email@test.com",
      ]);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Request body must be a JSON object",
      });
    });

    it("rejects null as body", async () => {
      const res = await makeRequest("POST", "/billing/org-123/customer", null);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Request body must be a JSON object",
      });
    });

    it("rejects missing email", async () => {
      const res = await makeRequest("POST", "/billing/org-123/customer", {
        name: "Test User",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Valid email is required" });
    });

    it("rejects empty email", async () => {
      const res = await makeRequest("POST", "/billing/org-123/customer", {
        email: "",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Valid email is required" });
    });

    it("rejects invalid email format", async () => {
      const res = await makeRequest("POST", "/billing/org-123/customer", {
        email: "not-an-email",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Valid email is required" });
    });

    it("rejects email without domain", async () => {
      const res = await makeRequest("POST", "/billing/org-123/customer", {
        email: "test@",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Valid email is required" });
    });

    it("rejects email exceeding max length (254 chars)", async () => {
      const longEmail = `${"a".repeat(250)}@test.com`;
      const res = await makeRequest("POST", "/billing/org-123/customer", {
        email: longEmail,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Valid email is required" });
    });

    it("rejects name exceeding max length (255 chars)", async () => {
      const longName = "a".repeat(256);
      const res = await makeRequest("POST", "/billing/org-123/customer", {
        email: "valid@email.com",
        name: longName,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Name must be a string under 255 characters",
      });
    });

    it("rejects non-string name", async () => {
      const res = await makeRequest("POST", "/billing/org-123/customer", {
        email: "valid@email.com",
        name: 12_345,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Name must be a string under 255 characters",
      });
    });
  });

  // ============================================================================
  // POST /:orgId/customer - Authorization Edge Cases
  // ============================================================================

  describe("POST /:orgId/customer - authorization edge cases", () => {
    it("returns 404 when organization not found in database", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve(null);
        }
        return Promise.resolve([]);
      });

      const res = await makeRequest("POST", "/billing/org-123/customer", {
        email: "valid@email.com",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Organization not found" });
    });

    it("rejects when organization already has a billing customer", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve({
            _id: "org-123",
            polarCustomerId: "existing-customer-id",
          });
        }
        return Promise.resolve([]);
      });

      const res = await makeRequest("POST", "/billing/org-123/customer", {
        email: "valid@email.com",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Organization already has a billing customer",
      });
    });
  });

  // ============================================================================
  // POST /:orgId/checkout - Input Validation
  // ============================================================================

  describe("POST /:orgId/checkout - input validation", () => {
    it("rejects invalid JSON body", async () => {
      const billingRoutes = (await import("./billing")).default;
      const app = new Hono<{ Bindings: Env }>();

      app.use("*", async (c, next) => {
        c.set("orgAccess" as never, createOrgAccessContext() as never);
        await next();
      });
      app.route("/billing", billingRoutes);

      const res = await app.request(
        "/billing/org-123/checkout",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{broken json",
        },
        MOCK_ENV
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    });

    it("rejects array as body", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", [
        "product-123",
      ]);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Request body must be a JSON object",
      });
    });

    it("rejects missing productId", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        successUrl: "https://example.com/success",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "productId is required" });
    });

    it("rejects empty productId", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "productId is required" });
    });

    it("rejects non-string productId", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: 12_345,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "productId is required" });
    });

    it("rejects invalid customerEmail", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
        customerEmail: "not-an-email",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "customerEmail must be a valid email",
      });
    });

    it("rejects non-boolean allowDiscountCodes", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
        allowDiscountCodes: "yes",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "allowDiscountCodes must be a boolean",
      });
    });
  });

  // ============================================================================
  // POST /:orgId/checkout - successUrl Validation
  // ============================================================================

  describe("POST /:orgId/checkout - successUrl validation", () => {
    it("rejects http:// URLs (not secure)", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
        successUrl: "http://example.com/success",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "successUrl must be a valid HTTPS URL",
      });
    });

    it("rejects ftp:// URLs", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
        successUrl: "ftp://example.com/success",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "successUrl must be a valid HTTPS URL",
      });
    });

    it("rejects javascript: URLs", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
        successUrl: "javascript:alert(1)",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "successUrl must be a valid HTTPS URL",
      });
    });

    it("rejects invalid URL format", async () => {
      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
        successUrl: "not-a-url",
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "successUrl must be a valid HTTPS URL",
      });
    });

    it("allows https:// URLs", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve({ _id: "org-123", polarCustomerId: null });
        }
        return Promise.resolve([]);
      });
      mockCreatePolarClient.mockReturnValue({
        checkouts: {
          create: vi
            .fn()
            .mockResolvedValue({ url: "https://checkout.polar.sh" }),
        },
      });

      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
        successUrl: "https://example.com/success",
      });

      expect(res.status).toBe(200);
    });

    it("allows localhost URLs (for development)", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve({ _id: "org-123", polarCustomerId: null });
        }
        return Promise.resolve([]);
      });
      mockCreatePolarClient.mockReturnValue({
        checkouts: {
          create: vi
            .fn()
            .mockResolvedValue({ url: "https://checkout.polar.sh" }),
        },
      });

      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
        successUrl: "http://localhost:3000/success",
      });

      expect(res.status).toBe(200);
    });

    it("allows 127.0.0.1 URLs (for development)", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve({ _id: "org-123", polarCustomerId: null });
        }
        return Promise.resolve([]);
      });
      mockCreatePolarClient.mockReturnValue({
        checkouts: {
          create: vi
            .fn()
            .mockResolvedValue({ url: "https://checkout.polar.sh" }),
        },
      });

      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
        successUrl: "http://127.0.0.1:3000/success",
      });

      expect(res.status).toBe(200);
    });

    it("allows undefined successUrl (optional field)", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve({ _id: "org-123", polarCustomerId: null });
        }
        return Promise.resolve([]);
      });
      mockCreatePolarClient.mockReturnValue({
        checkouts: {
          create: vi
            .fn()
            .mockResolvedValue({ url: "https://checkout.polar.sh" }),
        },
      });

      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
      });

      expect(res.status).toBe(200);
    });
  });

  // ============================================================================
  // POST /:orgId/checkout - Error Cases
  // ============================================================================

  describe("POST /:orgId/checkout - error cases", () => {
    it("returns 404 when organization not found", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve(null);
        }
        return Promise.resolve([]);
      });

      const res = await makeRequest("POST", "/billing/org-123/checkout", {
        productId: "prod-123",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Organization not found" });
    });
  });

  // ============================================================================
  // GET /:orgId/portal - Authorization Edge Cases
  // ============================================================================

  describe("GET /:orgId/portal - authorization edge cases", () => {
    it("returns 404 when organization not found", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve(null);
        }
        return Promise.resolve([]);
      });

      const res = await makeRequest("GET", "/billing/org-123/portal");

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Organization not found" });
    });

    it("returns 400 when no billing customer configured", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve({
            _id: "org-123",
            polarCustomerId: null,
          });
        }
        return Promise.resolve([]);
      });

      const res = await makeRequest("GET", "/billing/org-123/portal");

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "No billing customer configured",
      });
    });

    it("returns 400 when polarCustomerId is undefined", async () => {
      mockQuery.mockImplementation((name: string) => {
        if (name === "organizations:getById") {
          return Promise.resolve({ _id: "org-123" });
        }
        return Promise.resolve([]);
      });

      const res = await makeRequest("GET", "/billing/org-123/portal");

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "No billing customer configured",
      });
    });
  });
});
