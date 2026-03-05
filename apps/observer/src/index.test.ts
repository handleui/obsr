import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockEnv } from "./test-helpers/mock-env";

const { authHandlerMock, getBetterAuthMock } = vi.hoisted(() => ({
  authHandlerMock: vi.fn(),
  getBetterAuthMock: vi.fn(),
}));

vi.mock("@detent/sentry", () => ({
  scrubEvent: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
  withSentry: (_configFactory: unknown, worker: unknown) => worker,
  captureException: vi.fn(),
  setTag: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("./lib/better-auth", () => ({
  getBetterAuth: getBetterAuthMock,
}));

import { app } from "./index";

describe("observer auth route mounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBetterAuthMock.mockReturnValue({
      handler: authHandlerMock,
    });
  });

  it("routes GET /api/auth/* requests to Better Auth handler", async () => {
    authHandlerMock.mockResolvedValueOnce(new Response("ok-get"));

    const response = await app.request(
      "http://localhost/api/auth/session",
      {
        method: "GET",
      },
      createMockEnv()
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok-get");
    expect(getBetterAuthMock).toHaveBeenCalledTimes(1);
    expect(authHandlerMock).toHaveBeenCalledTimes(1);
  });

  it("routes POST /api/auth/* requests to Better Auth handler", async () => {
    authHandlerMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    );

    const response = await app.request(
      "http://localhost/api/auth/sign-in",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "github" }),
      },
      createMockEnv()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(getBetterAuthMock).toHaveBeenCalledTimes(1);
    expect(authHandlerMock).toHaveBeenCalledTimes(1);
  });
});
