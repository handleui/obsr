import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../auth/auth-provider";
import { createMockEnv } from "../test-helpers/mock-env";
import type { Env } from "../types/env";
import { authMiddleware } from "./auth";

const verifyBearerToken = vi.fn<AuthProvider["verifyBearerToken"]>();
const providerName = vi.hoisted(() => ({ value: "better-auth" }));

vi.mock("../auth/auth-provider", () => ({
  resolveAuthProvider: vi.fn(() => ({
    name: providerName.value,
    verifyBearerToken,
  })),
}));

const createApp = () => {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.get("/protected", (c) => c.json(c.get("auth")));
  return app;
};

describe("authMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerName.value = "better-auth";
  });

  it("returns 401 when authorization header is missing", async () => {
    const app = createApp();
    const response = await app.request("/protected", {}, createMockEnv());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Missing authorization header",
    });
    expect(verifyBearerToken).not.toHaveBeenCalled();
  });

  it("sets auth context from a valid bearer token", async () => {
    verifyBearerToken.mockResolvedValueOnce({
      userId: "user-123",
      organizationId: "org-123",
    });

    const env = createMockEnv();
    const app = createApp();
    const response = await app.request(
      "/protected",
      {
        headers: {
          Authorization: "Bearer token-123",
        },
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "user-123",
      organizationId: "org-123",
    });
    expect(verifyBearerToken).toHaveBeenCalledWith("token-123", env);
  });

  it("returns 401 when token verification fails", async () => {
    verifyBearerToken.mockRejectedValueOnce(new Error("invalid token"));

    const app = createApp();
    const response = await app.request(
      "/protected",
      {
        headers: {
          Authorization: "Bearer token-123",
        },
      },
      createMockEnv()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid or expired token",
    });
  });
});
