import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteError } from "@/lib/http";

const getAnalysisDetail = vi.fn();

vi.mock("@/lib/analysis/service", () => ({
  getAnalysisDetail,
}));

describe("analysis detail route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns analysis detail for an existing id", async () => {
    getAnalysisDetail.mockResolvedValue({
      id: "analysis_3",
      createdAt: "2026-04-01T12:00:00.000Z",
      inputKind: "paste",
      rawLogWasTruncated: false,
      summary: "One error found.",
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
      prompt: "CI summary:\nOne error found.",
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/analyses/1"), {
      params: Promise.resolve({ id: "analysis_3" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.id).toBe("analysis_3");
  });

  it("returns 404 when the analysis does not exist", async () => {
    getAnalysisDetail.mockRejectedValue(
      new RouteError(404, "NOT_FOUND", "Analysis not found.")
    );

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/analyses/1"), {
      params: Promise.resolve({ id: "missing" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error.code).toBe("NOT_FOUND");
  });
});
