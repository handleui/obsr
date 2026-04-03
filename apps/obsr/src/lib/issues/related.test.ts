import { describe, expect, it } from "vitest";
import { buildRelatedIssues } from "./related";

describe("buildRelatedIssues", () => {
  it("prefers repo overlap over lore overlap", () => {
    const result = buildRelatedIssues({
      candidates: [
        {
          id: "issue_repo",
          title: "Repo match",
          severity: "medium",
          status: "open",
          summary: "Repo fingerprint overlap.",
          lastSeenAt: new Date("2026-04-01T12:00:00.000Z"),
        },
        {
          id: "issue_lore",
          title: "Lore match",
          severity: "medium",
          status: "open",
          summary: "Lore fingerprint overlap.",
          lastSeenAt: new Date("2026-04-02T12:00:00.000Z"),
        },
      ],
      diagnostics: [
        {
          repoFingerprint: "repo_a",
          loreFingerprint: "lore_a",
        },
      ],
      fingerprintRows: [
        {
          issueId: "issue_repo",
          repoFingerprint: "repo_a",
          loreFingerprint: "lore_x",
        },
        {
          issueId: "issue_lore",
          repoFingerprint: "repo_x",
          loreFingerprint: "lore_a",
        },
      ],
    });

    expect(result[0]?.id).toBe("issue_repo");
    expect(result[0]?.matchReason).toContain("repo fingerprint");
  });

  it("filters candidates with no fingerprint overlap", () => {
    const result = buildRelatedIssues({
      candidates: [
        {
          id: "issue_none",
          title: "No overlap",
          severity: "medium",
          status: "open",
          summary: "No overlap.",
          lastSeenAt: new Date("2026-04-01T12:00:00.000Z"),
        },
      ],
      diagnostics: [
        {
          repoFingerprint: "repo_a",
          loreFingerprint: "lore_a",
        },
      ],
      fingerprintRows: [
        {
          issueId: "issue_none",
          repoFingerprint: "repo_b",
          loreFingerprint: "lore_b",
        },
      ],
    });

    expect(result).toEqual([]);
  });
});
