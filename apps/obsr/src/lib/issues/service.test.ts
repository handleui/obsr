import { beforeEach, describe, expect, it, vi } from "vitest";

const findIssueIdByObservationDedupeKey = vi.fn();
const getIssueAggregateById = vi.fn();
const listIssueFingerprintRows = vi.fn();
const listIssueClusterCandidateFingerprintRows = vi.fn();
const listIssueClusterCandidates = vi.fn();
const listRelatedIssueCandidates = vi.fn();
const listRecentIssues = vi.fn();
const persistIssueIngest = vi.fn();
const updateIssueSnapshot = vi.fn();
const textLogNormalize = vi.fn();
const sentryNormalize = vi.fn();
const synthesizeIssueSnapshot = vi.fn();
const SERVICE_MODULE = new URL("./service.ts", import.meta.url).href;

vi.mock("@/db/queries", () => ({
  findIssueIdByObservationDedupeKey,
  getIssueAggregateById,
  listIssueFingerprintRows,
  listIssueClusterCandidateFingerprintRows,
  listIssueClusterCandidates,
  listRelatedIssueCandidates,
  listRecentIssues,
  persistIssueIngest,
  updateIssueSnapshot,
}));

vi.mock("./adapters/text-log", () => ({
  textLogIssueAdapter: {
    sourceKinds: ["manual-log", "ci", "runtime-log", "dev-server"],
    normalize: textLogNormalize,
  },
}));

vi.mock("./adapters/sentry", () => ({
  sentryIssueAdapter: {
    sourceKinds: ["sentry"],
    normalize: sentryNormalize,
  },
}));

vi.mock("./synthesize", () => ({
  synthesizeIssueSnapshot,
}));

describe("issue service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it("ingests a new text-log issue and returns issue detail", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("issue_new");

    const capturedAt = new Date("2026-04-01T12:00:00.000Z");
    const observation = {
      id: "obs_1",
      issueId: "issue_new",
      sourceKind: "manual-log",
      rawText: "error TS2322",
      rawPayload: null,
      context: {
        environment: "local",
        repo: "obsr",
      },
      capturedAt,
      wasRedacted: false,
      wasTruncated: false,
    };
    const diagnostic = {
      id: "diag_1",
      issueId: "issue_new",
      observationId: "obs_1",
      fingerprint: "instance_1",
      repoFingerprint: "repo_1",
      loreFingerprint: "lore_1",
      message: "Type error",
      severity: "error",
      category: "type-check",
      source: "typescript",
      ruleId: "TS2322",
      filePath: "src/app/page.tsx",
      line: 2,
      column: 1,
      evidence: "Type error",
      createdAt: capturedAt,
    };

    textLogNormalize.mockResolvedValue({
      sourceKind: "manual-log",
      rawText: "error TS2322",
      context: {
        environment: "local",
        repo: "obsr",
      },
      capturedAt,
      wasRedacted: false,
      wasTruncated: false,
      diagnostics: [
        {
          fingerprint: "instance_1",
          repoFingerprint: "repo_1",
          loreFingerprint: "lore_1",
          message: "Type error",
          severity: "error",
          category: "type-check",
          source: "typescript",
          ruleId: "TS2322",
          filePath: "src/app/page.tsx",
          line: 2,
          column: 1,
          evidence: "Type error",
        },
      ],
    });
    findIssueIdByObservationDedupeKey.mockResolvedValue(null);
    listIssueClusterCandidates.mockResolvedValue([]);
    listIssueClusterCandidateFingerprintRows.mockResolvedValue([]);
    listRelatedIssueCandidates.mockResolvedValue([]);
    listIssueFingerprintRows.mockResolvedValue([]);
    persistIssueIngest.mockResolvedValue(observation);
    getIssueAggregateById
      .mockResolvedValueOnce({
        issue: {
          id: "issue_new",
          ownerUserId: "user_1",
          title: "New issue",
          severity: "medium",
          status: "open",
          primaryCategory: null,
          primarySourceKind: null,
          sourceKinds: [],
          summary: "Issue pending synthesis.",
          rootCause: null,
          plan: {
            summary: "Issue pending synthesis.",
            steps: [],
            validation: [],
            blockers: [],
          },
          clusterKey: "obsr::::local",
          repo: "obsr",
          app: null,
          service: null,
          environment: "local",
          firstSeenAt: capturedAt,
          lastSeenAt: capturedAt,
          observationCount: 1,
          diagnosticCount: 1,
        },
        observations: [observation],
        diagnostics: [diagnostic],
      })
      .mockResolvedValueOnce({
        issue: {
          id: "issue_new",
          ownerUserId: "user_1",
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
          clusterKey: "obsr::::local",
          repo: "obsr",
          app: null,
          service: null,
          environment: "local",
          firstSeenAt: capturedAt,
          lastSeenAt: capturedAt,
          observationCount: 1,
          diagnosticCount: 1,
        },
        observations: [observation],
        diagnostics: [diagnostic],
      });
    synthesizeIssueSnapshot.mockResolvedValue({
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
    });

    const { ingestIssue } = await import(SERVICE_MODULE);
    const result = await ingestIssue(
      {
        sourceKind: "manual-log",
        rawText: "error TS2322",
        context: {
          environment: "local",
          repo: "obsr",
        },
      },
      "user_1"
    );

    expect(listIssueClusterCandidates).toHaveBeenCalledWith(
      "obsr::_::_::local",
      "user_1"
    );
    expect(listIssueClusterCandidateFingerprintRows).toHaveBeenCalledWith(
      "obsr::_::_::local",
      "user_1"
    );
    expect(persistIssueIngest).toHaveBeenCalledWith({
      diagnostics: [
        {
          fingerprint: "instance_1",
          repoFingerprint: "repo_1",
          loreFingerprint: "lore_1",
          message: "Type error",
          severity: "error",
          category: "type-check",
          source: "typescript",
          ruleId: "TS2322",
          filePath: "src/app/page.tsx",
          line: 2,
          column: 1,
          evidence: "Type error",
        },
      ],
      issueShell: {
        id: "issue_new",
        ownerUserId: "user_1",
        clusterKey: "obsr::_::_::local",
        repo: "obsr",
        app: null,
        service: null,
        environment: "local",
        firstSeenAt: capturedAt,
      },
      observation: {
        issueId: "issue_new",
        ownerUserId: "user_1",
        sourceKind: "manual-log",
        rawText: "error TS2322",
        rawPayload: null,
        dedupeKey: null,
        context: {
          environment: "local",
          repo: "obsr",
        },
        capturedAt,
        wasRedacted: false,
        wasTruncated: false,
      },
    });
    expect(updateIssueSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "issue_new",
        ownerUserId: "user_1",
        observationCount: 1,
        diagnosticCount: 1,
      })
    );
    expect(result.id).toBe("issue_new");
    expect(result.title).toBe("TypeScript issue");
  });

  it("returns a UI-safe issue detail view", async () => {
    const capturedAt = new Date("2026-04-01T12:00:00.000Z");

    listRelatedIssueCandidates.mockResolvedValue([]);
    listIssueFingerprintRows.mockResolvedValue([]);
    getIssueAggregateById.mockResolvedValue({
      issue: {
        id: "issue_view",
        ownerUserId: "user_1",
        title: "Runtime issue",
        severity: "important",
        status: "open",
        primaryCategory: "runtime",
        primarySourceKind: "sentry",
        sourceKinds: ["sentry"],
        summary: "Runtime failed first.",
        rootCause: "Undefined access.",
        plan: {
          summary: "Guard the null access.",
          steps: ["Add the null check."],
          validation: ["The same request succeeds."],
          blockers: [],
        },
        clusterKey: "obsr::_::_::production",
        repo: "obsr",
        app: "web",
        service: null,
        environment: "production",
        firstSeenAt: capturedAt,
        lastSeenAt: capturedAt,
        observationCount: 1,
        diagnosticCount: 1,
      },
      observations: [
        {
          id: "obs_view",
          issueId: "issue_view",
          sourceKind: "sentry",
          rawText: "secret raw body",
          rawPayload: { token: "secret" },
          context: {
            environment: "production",
            repo: "obsr",
          },
          capturedAt,
          wasRedacted: true,
          wasTruncated: false,
        },
      ],
      diagnostics: [
        {
          id: "diag_view",
          issueId: "issue_view",
          observationId: "obs_view",
          fingerprint: "instance_view",
          repoFingerprint: "repo_view",
          loreFingerprint: "lore_view",
          message: "Undefined access",
          severity: "error",
          category: "runtime",
          source: "sentry",
          ruleId: "TypeError",
          filePath: "src/app/page.tsx",
          line: 42,
          column: 13,
          evidence: "Undefined access",
          createdAt: capturedAt,
        },
      ],
    });

    const { getIssueDetailView } = await import(SERVICE_MODULE);
    const result = await getIssueDetailView("issue_view", "user_1");

    expect(result.observations[0]).not.toHaveProperty("rawText");
    expect(result.observations[0]).not.toHaveProperty("rawPayload");
    expect(result.id).toBe("issue_view");
    expect(result.relatedIssues).toEqual([]);
    expect(getIssueAggregateById).toHaveBeenCalledWith("issue_view", "user_1");
  });

  it("returns 404 when the issue does not belong to the owner", async () => {
    getIssueAggregateById.mockResolvedValue(null);

    const { getIssueDetailView } = await import(SERVICE_MODULE);
    await expect(
      getIssueDetailView("issue_view", "user_2")
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("lists issues for one owner", async () => {
    listRecentIssues.mockResolvedValue([
      {
        id: "issue_1",
        title: "TypeScript issue",
        severity: "medium",
        status: "open",
        primaryCategory: "type-check",
        primarySourceKind: "manual-log",
        sourceKinds: ["manual-log"],
        summary: "TypeScript failed first.",
        lastSeenAt: new Date("2026-04-01T12:00:00.000Z"),
        observationCount: 1,
        diagnosticCount: 1,
      },
    ]);

    const { listIssues } = await import(SERVICE_MODULE);
    const result = await listIssues("user_1");

    expect(result).toHaveLength(1);
    expect(listRecentIssues).toHaveBeenCalledWith("user_1");
  });
});
