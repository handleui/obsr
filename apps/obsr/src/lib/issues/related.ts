import { MAX_RELATED_ISSUES } from "./constants";
import type { RelatedIssue } from "./schema";

interface RelatedIssueCandidate {
  id: string;
  title: string;
  severity: "important" | "medium" | "low";
  status: "open" | "resolved" | "ignored";
  summary: string;
  lastSeenAt: Date;
}

interface IssueFingerprintRow {
  issueId: string;
  repoFingerprint: string;
  loreFingerprint: string;
}

const countOverlap = (values: string[], input: Set<string>) => {
  let count = 0;

  for (const value of values) {
    if (input.has(value)) {
      count += 1;
    }
  }

  return count;
};

const getStatusScore = (status: RelatedIssueCandidate["status"]) => {
  return status === "open" ? 0 : 1;
};

const toMatchReason = (repoOverlap: number, loreOverlap: number) => {
  const parts: string[] = [];

  if (repoOverlap > 0) {
    parts.push(
      `${repoOverlap} shared repo fingerprint${repoOverlap === 1 ? "" : "s"}`
    );
  }

  if (loreOverlap > 0) {
    parts.push(
      `${loreOverlap} shared lore fingerprint${loreOverlap === 1 ? "" : "s"}`
    );
  }

  return parts.join(", ");
};

export const buildRelatedIssues = ({
  candidates,
  diagnostics,
  fingerprintRows,
}: {
  candidates: RelatedIssueCandidate[];
  diagnostics: Array<{
    repoFingerprint: string;
    loreFingerprint: string;
  }>;
  fingerprintRows: IssueFingerprintRow[];
}): RelatedIssue[] => {
  const repoFingerprints = new Set(
    diagnostics.map((diagnostic) => diagnostic.repoFingerprint)
  );
  const loreFingerprints = new Set(
    diagnostics.map((diagnostic) => diagnostic.loreFingerprint)
  );
  const fingerprintsByIssue = new Map<
    string,
    {
      lore: string[];
      repo: string[];
    }
  >();

  for (const row of fingerprintRows) {
    const existing = fingerprintsByIssue.get(row.issueId) ?? {
      lore: [],
      repo: [],
    };
    existing.repo.push(row.repoFingerprint);
    existing.lore.push(row.loreFingerprint);
    fingerprintsByIssue.set(row.issueId, existing);
  }

  return candidates
    .map((candidate) => {
      const fingerprints = fingerprintsByIssue.get(candidate.id) ?? {
        lore: [],
        repo: [],
      };
      const repoOverlap = countOverlap(fingerprints.repo, repoFingerprints);
      const loreOverlap = countOverlap(fingerprints.lore, loreFingerprints);

      return {
        ...candidate,
        loreOverlap,
        matchReason: toMatchReason(repoOverlap, loreOverlap),
        repoOverlap,
      };
    })
    .filter(
      (candidate) => candidate.repoOverlap > 0 || candidate.loreOverlap > 0
    )
    .sort((left, right) => {
      return (
        right.repoOverlap - left.repoOverlap ||
        right.loreOverlap - left.loreOverlap ||
        getStatusScore(left.status) - getStatusScore(right.status) ||
        right.lastSeenAt.getTime() - left.lastSeenAt.getTime()
      );
    })
    .slice(0, MAX_RELATED_ISSUES)
    .map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      status: candidate.status,
      severity: candidate.severity,
      summary: candidate.summary,
      lastSeenAt: candidate.lastSeenAt.toISOString(),
      matchReason: candidate.matchReason,
    }));
};
