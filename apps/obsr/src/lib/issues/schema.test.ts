import { describe, expect, it } from "vitest";
import {
  IssueCreatedSchema,
  IssueDetailViewSchema,
  IssueIngestInputSchema,
} from "./schema";

describe("issue ingest schema", () => {
  it("accepts log-based input", () => {
    const result = IssueIngestInputSchema.parse({
      capturedAt: "2026-04-01T12:00:00.000Z",
      dedupeKey: "vercel:build:dep_1",
      sourceKind: "manual-log",
      rawText: "error TS2322",
      context: {
        environment: "local",
      },
    });

    expect(result.sourceKind).toBe("manual-log");
    expect(result.dedupeKey).toBe("vercel:build:dep_1");
  });

  it("accepts sentry payloads", () => {
    const result = IssueIngestInputSchema.parse({
      sourceKind: "sentry",
      rawPayload: {
        title: "TypeError",
      },
      context: {
        environment: "production",
      },
    });

    expect(result.sourceKind).toBe("sentry");
  });

  it("rejects missing raw input for log observations", () => {
    expect(() =>
      IssueIngestInputSchema.parse({
        sourceKind: "manual-log",
        context: {
          environment: "local",
        },
      })
    ).toThrow();
  });

  it("rejects oversized raw text", () => {
    expect(() =>
      IssueIngestInputSchema.parse({
        sourceKind: "manual-log",
        rawText: "x".repeat(120_001),
        context: {
          environment: "local",
        },
      })
    ).toThrow();
  });

  it("accepts a UI-safe issue detail payload", () => {
    const result = IssueDetailViewSchema.parse({
      id: "issue_1",
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
      observations: [
        {
          id: "obs_1",
          issueId: "issue_1",
          sourceKind: "manual-log",
          context: {
            environment: "local",
          },
          capturedAt: "2026-04-01T12:00:00.000Z",
          wasRedacted: false,
          wasTruncated: false,
        },
      ],
      diagnostics: [],
      relatedIssues: [],
      brief: "Issue: TypeScript issue",
    });

    expect(result.observations[0]).not.toHaveProperty("rawText");
  });

  it("accepts a minimal created payload", () => {
    const result = IssueCreatedSchema.parse({
      id: "issue_1",
    });

    expect(result.id).toBe("issue_1");
  });
});
