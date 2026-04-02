import { describe, expect, it } from "vitest";
import { selectIssueClusterMatch } from "./cluster";

describe("selectIssueClusterMatch", () => {
  it("attaches when repo fingerprints overlap", () => {
    const match = selectIssueClusterMatch({
      candidates: [
        {
          issueId: "issue_1",
          status: "open",
          lastSeenAt: new Date("2026-04-01T12:00:00.000Z"),
          repoFingerprints: ["repo_a"],
          loreFingerprints: ["lore_a"],
        },
      ],
      diagnostics: [
        {
          fingerprint: "instance_a",
          repoFingerprint: "repo_a",
          loreFingerprint: "lore_b",
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

    expect(match).toBe("issue_1");
  });

  it("prefers false split on one weak lore overlap", () => {
    const match = selectIssueClusterMatch({
      candidates: [
        {
          issueId: "issue_1",
          status: "open",
          lastSeenAt: new Date("2026-04-01T12:00:00.000Z"),
          repoFingerprints: [],
          loreFingerprints: ["lore_a"],
        },
      ],
      diagnostics: [
        {
          fingerprint: "instance_a",
          repoFingerprint: "repo_b",
          loreFingerprint: "lore_a",
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

    expect(match).toBeNull();
  });

  it("never attaches to ignored issues", () => {
    const match = selectIssueClusterMatch({
      candidates: [
        {
          issueId: "issue_1",
          status: "ignored",
          lastSeenAt: new Date("2026-04-01T12:00:00.000Z"),
          repoFingerprints: ["repo_a"],
          loreFingerprints: [],
        },
      ],
      diagnostics: [
        {
          fingerprint: "instance_a",
          repoFingerprint: "repo_a",
          loreFingerprint: "lore_a",
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

    expect(match).toBeNull();
  });
});
