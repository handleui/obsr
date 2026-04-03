import { beforeEach, describe, expect, it, vi } from "vitest";

const findIssueIdByObservationDedupeKey = vi.fn();
const getVercelConnection = vi.fn();
const listOwnedVercelSyncTargetsByIds = vi.fn();
const listVercelSyncTargets = vi.fn();
const upsertVercelConnection = vi.fn();
const updateVercelSyncTargetCursor = vi.fn();
const decryptSecret = vi.fn();
const encryptSecret = vi.fn();
const getIssueAggregateById = vi.fn();
const listIssueClusterCandidateFingerprintRows = vi.fn();
const listIssueClusterCandidates = vi.fn();
const listIssueFingerprintRows = vi.fn();
const listRelatedIssueCandidates = vi.fn();
const listRecentIssues = vi.fn();
const listDeployments = vi.fn();
const listDeploymentEvents = vi.fn();
const listRuntimeLogs = vi.fn();
const ingestIssue = vi.fn();
const persistIssueIngest = vi.fn();
const updateIssueSnapshot = vi.fn();

vi.mock("@/db/queries", () => ({
  findIssueIdByObservationDedupeKey,
  getIssueAggregateById,
  listIssueClusterCandidateFingerprintRows,
  listIssueClusterCandidates,
  listIssueFingerprintRows,
  listRelatedIssueCandidates,
  listRecentIssues,
  persistIssueIngest,
  updateIssueSnapshot,
}));

vi.mock("@/db/vercel-queries", () => ({
  getVercelConnection,
  listOwnedVercelSyncTargetsByIds,
  listVercelSyncTargets,
  upsertVercelConnection,
  updateVercelSyncTargetCursor,
}));

vi.mock("@/lib/crypto", () => ({
  decryptSecret,
  encryptSecret,
}));

vi.mock("./client", () => ({
  VercelApiClient: class {
    listDeployments = listDeployments;
    listDeploymentEvents = listDeploymentEvents;
    listRuntimeLogs = listRuntimeLogs;
  },
}));

describe("vercel service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("saves an encrypted connection and returns serialized targets", async () => {
    encryptSecret.mockReturnValue("encrypted-token");
    upsertVercelConnection.mockResolvedValue(undefined);
    listVercelSyncTargets.mockResolvedValue([
      {
        id: "target_1",
        ownerUserId: "user_1",
        teamId: "team_1",
        teamSlug: "acme",
        projectId: "prj_1",
        projectName: "obsr",
        repo: "handleui/obsr",
        lastSyncedAt: new Date("2026-04-01T12:00:00.000Z"),
        lastDeploymentCreatedAt: null,
        createdAt: new Date("2026-04-01T12:00:00.000Z"),
        updatedAt: new Date("2026-04-01T12:00:00.000Z"),
      },
    ]);

    const { saveVercelConnection } = await import("./service");
    const result = await saveVercelConnection("user_1", {
      accessToken: "token",
      targets: [
        {
          projectId: "prj_1",
          teamId: "team_1",
        },
      ],
    });

    expect(upsertVercelConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedAccessToken: "encrypted-token",
      })
    );
    expect(result.targets[0]?.lastSyncedAt).toBe("2026-04-01T12:00:00.000Z");
  });

  it("syncs owned targets and skips duplicate observations", async () => {
    getVercelConnection.mockResolvedValue({
      encryptedAccessToken: "encrypted-token",
    });
    decryptSecret.mockReturnValue("plain-token");
    listOwnedVercelSyncTargetsByIds.mockResolvedValue([
      {
        id: "target_1",
        ownerUserId: "user_1",
        teamId: "team_1",
        teamSlug: "acme",
        projectId: "prj_1",
        projectName: "obsr",
        repo: "handleui/obsr",
        lastSyncedAt: new Date("2026-04-01T12:00:00.000Z"),
        lastDeploymentCreatedAt: new Date("2026-04-01T11:00:00.000Z"),
        createdAt: new Date("2026-04-01T12:00:00.000Z"),
        updatedAt: new Date("2026-04-01T12:00:00.000Z"),
      },
    ]);
    listDeployments.mockResolvedValue([
      {
        createdAt: 1_775_184_000_000,
        name: "obsr",
        readyState: "ERROR",
        target: "production",
        uid: "dep_1",
        url: "obsr.vercel.app",
      },
    ]);
    listDeploymentEvents.mockResolvedValue([
      {
        payload: {
          text: "Build failed",
        },
      },
    ]);
    listRuntimeLogs.mockResolvedValue([
      {
        message: "Unhandled exception",
        requestId: "req_1",
        requestPath: "/api/issues",
        rowId: "row_1",
        timestampInMs: 1_775_184_000_000,
      },
    ]);
    findIssueIdByObservationDedupeKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("issue_existing");
    ingestIssue.mockResolvedValue({
      id: "issue_created",
    });

    const { syncVercelTargets } = await import("./service");
    const result = await syncVercelTargets(
      "user_1",
      {
        targetIds: ["target_1"],
      },
      {
        ingestIssueFn: ingestIssue,
      }
    );

    expect(listOwnedVercelSyncTargetsByIds).toHaveBeenCalledWith("user_1", [
      "target_1",
    ]);
    expect(ingestIssue).toHaveBeenCalledTimes(1);
    expect(updateVercelSyncTargetCursor).toHaveBeenCalled();
    expect(result.observationsCreated).toBe(1);
    expect(result.observationsSkipped).toBe(1);
    expect(result.issueIds).toEqual(
      expect.arrayContaining(["issue_created", "issue_existing"])
    );
  });
});
