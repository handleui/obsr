import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteError } from "@/lib/http";

const ingestIssue = vi.fn();
const listIssues = vi.fn();
const toIssueCreated = vi.fn();

vi.mock("@/lib/issues/service", () => ({
  ingestIssue,
  listIssues,
  toIssueCreated,
}));

describe("issues collection routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload[0]?.id).toBe("issue_1");
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
    expect(payload.id).toBe("issue_2");
    expect(ingestIssue).toHaveBeenCalledOnce();
    expect(toIssueCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "issue_2" })
    );
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
