import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteError } from "@/lib/http";

const requireAuthenticatedUser = vi.fn();
const getVercelTargets = vi.fn();
const saveVercelConnection = vi.fn();
const syncVercelTargets = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAuthenticatedUser,
}));

vi.mock("@/lib/vercel/service", () => ({
  getVercelTargets,
  saveVercelConnection,
  syncVercelTargets,
}));

describe("vercel targets route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireAuthenticatedUser.mockResolvedValue({
      id: "user_1",
    });
  });

  it("lists saved targets", async () => {
    getVercelTargets.mockResolvedValue([
      {
        id: "target_1",
        teamId: "team_1",
        teamSlug: "acme",
        projectId: "prj_1",
        projectName: "obsr",
        repo: "handleui/obsr",
        lastSyncedAt: null,
        lastDeploymentCreatedAt: null,
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/vercel/targets")
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload[0]?.id).toBe("target_1");
    expect(getVercelTargets).toHaveBeenCalledWith("user_1");
  });

  it("rejects unauthenticated access", async () => {
    requireAuthenticatedUser.mockRejectedValue(
      new RouteError(401, "UNAUTHORIZED", "Authentication required.")
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/vercel/targets")
    );

    expect(response.status).toBe(401);
    expect(getVercelTargets).not.toHaveBeenCalled();
  });
});
