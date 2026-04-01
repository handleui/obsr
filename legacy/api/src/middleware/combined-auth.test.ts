import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEnv } from "../test-helpers/mock-env";
import type { Env } from "../types/env";
import { combinedAuthMiddleware } from "./combined-auth";

const { authMiddlewareMock, apiKeyAuthMiddlewareMock } = vi.hoisted(() => ({
  authMiddlewareMock: vi.fn(),
  apiKeyAuthMiddlewareMock: vi.fn(),
}));

vi.mock("./auth", () => ({
  authMiddleware: authMiddlewareMock,
}));

vi.mock("./api-key-auth", () => ({
  apiKeyAuthMiddleware: apiKeyAuthMiddlewareMock,
}));

const createApp = () => {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", combinedAuthMiddleware);
  app.get("/protected", (c) => c.json({ ok: true }));
  return app;
};

describe("combinedAuthMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMiddlewareMock.mockImplementation(async (_c, next) => {
      await next();
      return undefined;
    });
    apiKeyAuthMiddlewareMock.mockImplementation(async (_c, next) => {
      await next();
      return undefined;
    });
  });

  it("rejects requests using both auth mechanisms", async () => {
    const app = createApp();
    const response = await app.request(
      "/protected",
      {
        headers: {
          Authorization: "Bearer test-token",
          "X-Detent-Token": "dtk_12345678901234567890123456789012",
        },
      },
      createMockEnv()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Provide only one authentication method",
    });
    expect(authMiddlewareMock).not.toHaveBeenCalled();
    expect(apiKeyAuthMiddlewareMock).not.toHaveBeenCalled();
  });

  it("routes bearer token requests to authMiddleware", async () => {
    const app = createApp();
    const response = await app.request(
      "/protected",
      {
        headers: {
          Authorization: "Bearer test-token",
        },
      },
      createMockEnv()
    );

    expect(response.status).toBe(200);
    expect(authMiddlewareMock).toHaveBeenCalledTimes(1);
    expect(apiKeyAuthMiddlewareMock).not.toHaveBeenCalled();
  });

  it("routes API key requests to apiKeyAuthMiddleware", async () => {
    const app = createApp();
    const response = await app.request(
      "/protected",
      {
        headers: {
          "X-Detent-Token": "dtk_12345678901234567890123456789012",
        },
      },
      createMockEnv()
    );

    expect(response.status).toBe(200);
    expect(apiKeyAuthMiddlewareMock).toHaveBeenCalledTimes(1);
    expect(authMiddlewareMock).not.toHaveBeenCalled();
  });

  it("returns 401 when no auth headers are provided", async () => {
    const app = createApp();
    const response = await app.request("/protected", {}, createMockEnv());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
    });
    expect(authMiddlewareMock).not.toHaveBeenCalled();
    expect(apiKeyAuthMiddlewareMock).not.toHaveBeenCalled();
  });
});
