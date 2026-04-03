import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteError } from "@/lib/http";

const requireAuthenticatedUser = vi.fn();
const saveVercelConnection = vi.fn();
const authUser = {
  id: "user_1",
  createdAt: new Date("2026-04-01T12:00:00.000Z"),
  updatedAt: new Date("2026-04-01T12:00:00.000Z"),
  email: "user_1@example.com",
  emailVerified: true,
  name: "User One",
  image: null,
};

vi.mock("@/lib/auth-session", () => ({
  requireAuthenticatedUser,
}));

vi.mock("@/lib/vercel/service", () => ({
  saveVercelConnection,
}));

describe("vercel connection route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireAuthenticatedUser.mockResolvedValue(authUser);
  });

  it("saves a connection for the authenticated user", async () => {
    saveVercelConnection.mockResolvedValue({
      configured: true,
      targets: [],
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/vercel/connection", {
        body: JSON.stringify({
          accessToken: "token",
          targets: [
            {
              projectId: "prj_1",
              teamId: "team_1",
            },
          ],
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })
    );

    expect(response.status).toBe(200);
    expect(saveVercelConnection).toHaveBeenCalledWith(
      "user_1",
      expect.objectContaining({
        accessToken: "token",
      })
    );
  });

  it("rejects unauthenticated access", async () => {
    requireAuthenticatedUser.mockRejectedValue(
      new RouteError(401, "UNAUTHORIZED", "Authentication required.")
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/vercel/connection", {
        body: JSON.stringify({
          accessToken: "token",
          targets: [],
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })
    );

    expect(response.status).toBe(401);
    expect(saveVercelConnection).not.toHaveBeenCalled();
  });
});
