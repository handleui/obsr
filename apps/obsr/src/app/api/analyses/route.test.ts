import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteError } from "@/lib/http";

const createAnalysis = vi.fn();
const listAnalyses = vi.fn();

vi.mock("@/lib/analysis/service", () => ({
  createAnalysis,
  listAnalyses,
}));

describe("analyses collection routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns recent analyses on GET", async () => {
    listAnalyses.mockResolvedValue([
      {
        id: "analysis_1",
        createdAt: "2026-04-01T12:00:00.000Z",
        inputKind: "paste",
        summary: "One error found.",
        diagnosticCount: 1,
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload[0]?.id).toBe("analysis_1");
  });

  it("creates an analysis on POST happy path", async () => {
    createAnalysis.mockResolvedValue({
      id: "analysis_2",
      createdAt: "2026-04-01T12:00:00.000Z",
      inputKind: "paste",
      rawLogWasTruncated: false,
      summary: "TypeScript failed first.",
      diagnosticCount: 1,
      diagnostics: [
        {
          fingerprint: "abc",
          message: "Type error",
          severity: "error",
          category: "type-check",
          source: "typescript",
          filePath: "src/app/page.tsx",
          line: 4,
          column: 1,
          ruleId: "TS2322",
          evidence: "Code 4-6",
          rank: 0,
        },
      ],
      prompt: "CI summary:\nTypeScript failed first.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/analyses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          inputKind: "paste",
          rawLog: "error TS2322",
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.id).toBe("analysis_2");
    expect(createAnalysis).toHaveBeenCalledOnce();
  });

  it("returns 400 for invalid input", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/analyses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rawLog: 42,
        }),
      })
    );

    expect(response.status).toBe(400);
  });

  it("rejects non-json requests", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/analyses", {
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
      new Request("http://localhost/api/analyses", {
        body: JSON.stringify({
          inputKind: "paste",
          rawLog: "error TS2322",
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

  it("rejects oversized streamed requests without content-length", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/analyses", {
        body: JSON.stringify({
          inputKind: "paste",
          rawLog: "x".repeat(600_000),
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.error.code).toBe("INPUT_TOO_LARGE");
    expect(createAnalysis).not.toHaveBeenCalled();
  });

  it("returns service errors for empty or invalid analyses", async () => {
    createAnalysis.mockRejectedValue(
      new RouteError(422, "NO_DIAGNOSTICS", "No diagnostics.")
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/analyses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          inputKind: "paste",
          rawLog: "clean build",
        }),
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.error.code).toBe("NO_DIAGNOSTICS");
  });
});
