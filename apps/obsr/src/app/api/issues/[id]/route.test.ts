import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteError } from "@/lib/http";

const requireAuthenticatedUser = vi.fn();
const getIssueDetailView = vi.fn();
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

vi.mock("@/lib/issues/service", () => ({
  getIssueDetailView,
}));

describe("issue detail route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireAuthenticatedUser.mockResolvedValue(authUser);
  });

  it("returns issue detail for an existing id", async () => {
    getIssueDetailView.mockResolvedValue({
      id: "issue_3",
      title: "TypeScript issue",
      severity: "medium",
      status: "open",
      primaryCategory: "type-check",
      primarySourceKind: "manual-log",
      sourceKinds: ["manual-log"],
      summary: "TypeScript failed first.",
      rootCause: "Type mismatch.",
      plan: {
        summary: "Fix the type mismatch.",
        steps: ["Update the prop type."],
        validation: ["bun run check-types passes."],
        blockers: [],
      },
      firstSeenAt: "2026-04-01T12:00:00.000Z",
      lastSeenAt: "2026-04-01T12:00:00.000Z",
      observationCount: 1,
      diagnosticCount: 1,
      observations: [],
      diagnostics: [],
      relatedIssues: [],
      brief: "Issue: TypeScript issue",
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/issues/1"), {
      params: Promise.resolve({ id: "issue_3" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(payload.id).toBe("issue_3");
    expect(getIssueDetailView).toHaveBeenCalledWith("issue_3", "user_1");
  });

  it("returns 404 when the issue does not exist", async () => {
    getIssueDetailView.mockRejectedValue(
      new RouteError(404, "NOT_FOUND", "Issue not found.")
    );

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/issues/1"), {
      params: Promise.resolve({ id: "missing" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe("NOT_FOUND");
  });

  it("returns 401 when the request is unauthenticated", async () => {
    requireAuthenticatedUser.mockRejectedValue(
      new RouteError(401, "UNAUTHORIZED", "Authentication required.")
    );

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/issues/1"), {
      params: Promise.resolve({ id: "issue_3" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("UNAUTHORIZED");
    expect(getIssueDetailView).not.toHaveBeenCalled();
  });
});
