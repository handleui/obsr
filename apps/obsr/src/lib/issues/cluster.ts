import type { IssueDiagnosticDraft } from "./adapters/types";
import type { IssueStatus } from "./schema";

export interface ClusterCandidate {
  issueId: string;
  status: IssueStatus;
  lastSeenAt: Date;
  repoFingerprints: string[];
  loreFingerprints: string[];
}

const countOverlap = (candidateValues: string[], inputValues: Set<string>) => {
  let matches = 0;

  for (const value of candidateValues) {
    if (inputValues.has(value)) {
      matches += 1;
    }
  }

  return matches;
};

export const selectIssueClusterMatch = ({
  candidates,
  diagnostics,
}: {
  candidates: ClusterCandidate[];
  diagnostics: IssueDiagnosticDraft[];
}) => {
  const repoFingerprints = new Set(
    diagnostics.map((diagnostic) => diagnostic.repoFingerprint)
  );
  const loreFingerprints = new Set(
    diagnostics.map((diagnostic) => diagnostic.loreFingerprint)
  );

  const scored = candidates
    .filter((candidate) => candidate.status !== "ignored")
    .map((candidate) => {
      const repoOverlap = countOverlap(
        candidate.repoFingerprints,
        repoFingerprints
      );
      const loreOverlap = countOverlap(
        candidate.loreFingerprints,
        loreFingerprints
      );

      return {
        issueId: candidate.issueId,
        score: repoOverlap * 3 + loreOverlap,
        lastSeenAt: candidate.lastSeenAt,
      };
    })
    .filter((candidate) => candidate.score >= 2)
    .sort((left, right) => {
      return (
        right.score - left.score ||
        right.lastSeenAt.getTime() - left.lastSeenAt.getTime()
      );
    });

  return scored[0]?.issueId ?? null;
};
