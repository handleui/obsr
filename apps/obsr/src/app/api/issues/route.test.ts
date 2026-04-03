import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteError } from "@/lib/http";

const requireAuthenticatedUser = vi.fn();
const ingestIssue = vi.fn();
const listIssues = vi.fn();
const toIssueCreated = vi.fn();
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
  ingestIssue,
  listIssues,
  toIssueCreated,
}));

describe("issues collection routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requireAuthenticatedUser.mockResolvedValue(authUser);
  });

  it("returns recent issues on GET", async () => {
    listIssues.mockResolvedValue([
      {
        id: "issue_1",
        title: "TypeScript issue",
        severity: "medium",
        status: "open",
        primaryCategory: "type-check",
        primarySourceKind: "manual-log",
        sourceKinds: ["manual-log"],
        summary: "TypeScript failed first.",
        lastSeenAt: "2026-04-01T12:00:00.000Z",
        observationCount: 1,
        diagnosticCount: 1,
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/issues"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(payload[0]?.id).toBe("issue_1");
    expect(listIssues).toHaveBeenCalledWith("user_1");
  });

  it("creates an issue on POST happy path", async () => {
    ingestIssue.mockResolvedValue({
      id: "issue_2",
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
    toIssueCreated.mockReturnValue({
      id: "issue_2",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/issues", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceKind: "manual-log",
          rawText: "error TS2322",
          context: {
            environment: "local",
          },
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(payload.id).toBe("issue_2");
    expect(ingestIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "manual-log",
      }),
      "user_1"
    );
    expect(toIssueCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "issue_2" })
    );
  });

  it("returns 401 on GET when the request is unauthenticated", async () => {
    requireAuthenticatedUser.mockRejectedValue(
      new RouteError(401, "UNAUTHORIZED", "Authentication required.")
    );

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/issues"));
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("UNAUTHORIZED");
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid input", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/issues", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceKind: "manual-log",
          rawText: 42,
        }),
      })
    );

    expect(response.status).toBe(400);
  });

  it("returns 401 on POST when the request is unauthenticated", async () => {
    requireAuthenticatedUser.mockRejectedValue(
      new RouteError(401, "UNAUTHORIZED", "Authentication required.")
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/issues", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceKind: "manual-log",
          rawText: "error TS2322",
          context: {
            environment: "local",
          },
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error.code).toBe("UNAUTHORIZED");
    expect(ingestIssue).not.toHaveBeenCalled();
  });

  it("rejects non-json requests", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/issues", {
        body: "error TS2322",
        headers: {
          "content-type": "text/plain",
        },
        method: "POST",
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(415);
    expect(payload.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("rejects oversized requests before parsing", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/issues", {
        body: JSON.stringify({
          sourceKind: "manual-log",
          rawText: "error TS2322",
          context: {
            environment: "local",
          },
        }),
        headers: {
          "content-length": "600000",
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.error.code).toBe("INPUT_TOO_LARGE");
  });

  it("returns service errors for invalid issues", async () => {
    ingestIssue.mockRejectedValue(
      new RouteError(422, "NO_DIAGNOSTICS", "No diagnostics.")
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/issues", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceKind: "manual-log",
          rawText: "clean build",
          context: {
            environment: "local",
          },
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.error.code).toBe("NO_DIAGNOSTICS");
  });
});
