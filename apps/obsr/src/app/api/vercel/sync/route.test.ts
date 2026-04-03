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

describe("vercel sync route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireAuthenticatedUser.mockResolvedValue({
      id: "user_1",
    });
  });

  it("syncs selected targets", async () => {
    syncVercelTargets.mockResolvedValue({
      targetsSynced: 1,
      deploymentsSeen: 2,
      observationsCreated: 1,
      observationsSkipped: 1,
      issueIds: ["issue_1"],
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/vercel/sync", {
        body: JSON.stringify({
          targetIds: ["target_1"],
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.targetsSynced).toBe(1);
    expect(syncVercelTargets).toHaveBeenCalledWith("user_1", {
      targetIds: ["target_1"],
    });
  });

  it("rejects unauthenticated sync requests", async () => {
    requireAuthenticatedUser.mockRejectedValue(
      new RouteError(401, "UNAUTHORIZED", "Authentication required.")
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/vercel/sync", {
        body: JSON.stringify({}),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })
    );

    expect(response.status).toBe(401);
    expect(syncVercelTargets).not.toHaveBeenCalled();
  });
});
