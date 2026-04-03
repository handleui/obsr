import { describe, expect, it, vi } from "vitest";
import type { RouteError } from "@/lib/http";

const getSession = vi.fn();

vi.mock("./auth", () => ({
  getAuth: () => ({
    api: {
      getSession,
    },
  }),
}));

describe("requireAuthenticatedUser", () => {
  it("returns the authenticated user", async () => {
    getSession.mockResolvedValue({
      user: {
        id: "user_1",
        name: "ObsR",
      },
    });

    const { requireAuthenticatedUser } = await import("./auth-session");
    const result = await requireAuthenticatedUser(
      new Request("http://localhost/api/issues")
    );

    expect(result).toEqual({
      id: "user_1",
      name: "ObsR",
    });
  });

  it("throws a 401 when the session is missing", async () => {
    getSession.mockResolvedValue(null);

    const { requireAuthenticatedUser } = await import("./auth-session");

    await expect(
      requireAuthenticatedUser(new Request("http://localhost/api/issues"))
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Authentication required.",
      status: 401,
    } satisfies Partial<RouteError>);
  });
});
