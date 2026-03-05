import type { ExecutionContext } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEnv, createMockKv } from "../test-helpers/mock-env";
import type { Env } from "../types/env";
import { apiKeyAuthMiddleware } from "./api-key-auth";

const { hashApiKeyMock, queryMock, mutationMock } = vi.hoisted(() => ({
  hashApiKeyMock: vi.fn(),
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
}));

vi.mock("../lib/crypto", () => ({
  hashApiKey: hashApiKeyMock,
}));

vi.mock("../db/client", () => ({
  getDbClient: vi.fn(() => ({
    query: queryMock,
    mutation: mutationMock,
  })),
}));

const createExecutionContext = (): ExecutionContext =>
  ({
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  }) as unknown as ExecutionContext;

const createApp = () => {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", apiKeyAuthMiddleware);
  app.get("/protected", (c) => c.json(c.get("apiKeyAuth")));
  return app;
};

describe("apiKeyAuthMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when API key header is missing", async () => {
    const app = createApp();
    const response = await app.request(
      "/protected",
      {},
      createMockEnv(),
      createExecutionContext()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required",
    });
    expect(hashApiKeyMock).not.toHaveBeenCalled();
  });

  it("returns 401 for invalid API key format", async () => {
    const app = createApp();
    const response = await app.request(
      "/protected",
      {
        headers: {
          "X-Detent-Token": "invalid-token",
        },
      },
      createMockEnv(),
      createExecutionContext()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication failed",
    });
    expect(hashApiKeyMock).not.toHaveBeenCalled();
  });

  it("returns 401 when API key hash lookup misses", async () => {
    hashApiKeyMock.mockResolvedValueOnce("api-key-hash");
    queryMock.mockResolvedValueOnce(null);

    const app = createApp();
    const response = await app.request(
      "/protected",
      {
        headers: {
          "X-Detent-Token": "dtk_12345678901234567890123456789012",
        },
      },
      createMockEnv(),
      createExecutionContext()
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication failed",
    });
    expect(queryMock).toHaveBeenCalledWith("api_keys:getByKeyHash", {
      keyHash: "api-key-hash",
    });
  });

  it("sets apiKeyAuth context for a valid API key", async () => {
    hashApiKeyMock.mockResolvedValueOnce("api-key-hash");
    queryMock
      .mockResolvedValueOnce({
        _id: "api-key-id",
        organizationId: "org-123",
        keyHash: "api-key-hash",
      })
      .mockResolvedValueOnce({
        settings: {
          validationEnabled: true,
        },
      });
    mutationMock.mockResolvedValueOnce(null);

    const executionCtx = createExecutionContext();
    const app = createApp();
    const response = await app.request(
      "/protected",
      {
        headers: {
          "X-Detent-Token": "dtk_12345678901234567890123456789012",
        },
      },
      createMockEnv(),
      executionCtx
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organizationId: "org-123",
      orgSettings: {
        validationEnabled: true,
      },
    });
    expect(mutationMock).toHaveBeenCalledWith("api_keys:updateLastUsedAt", {
      id: "api-key-id",
      lastUsedAt: expect.any(Number),
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("uses KV cache and skips dbClient lookup on cache hit", async () => {
    const kv = createMockKv();
    const getMock = vi.fn().mockResolvedValue({
      _id: "api-key-id",
      organizationId: "org-cached",
      keyHash: "cached-hash",
      orgSettings: {
        validationEnabled: true,
      },
    });

    const env = createMockEnv({
      "detent-idempotency": {
        ...kv,
        get: getMock,
      } as Env["detent-idempotency"],
    });

    hashApiKeyMock.mockResolvedValueOnce("cached-hash");
    mutationMock.mockResolvedValueOnce(null);

    const app = createApp();
    const response = await app.request(
      "/protected",
      {
        headers: {
          "X-Detent-Token": "dtk_12345678901234567890123456789012",
        },
      },
      env,
      createExecutionContext()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organizationId: "org-cached",
      orgSettings: {
        validationEnabled: true,
      },
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
