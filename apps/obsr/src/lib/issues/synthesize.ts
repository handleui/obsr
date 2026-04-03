import { isResponsesRequestError } from "@obsr/ai";
import { normalizeSourceKinds, rankIssueDiagnostics } from "@obsr/issues";
import { scrubFilePath, scrubSecrets } from "@obsr/types";
import type { IssueDiagnosticDraft } from "./adapters/types";
import {
  type IssueSynthesisProvider,
  responsesIssueSynthesisProvider,
} from "./issue-agent";
import type {
  Issue,
  IssueCategory,
  IssueObservation,
  IssuePlan,
  IssueSeverity,
  ObservationSourceKind,
  RelatedIssue,
} from "./schema";

export interface IssueSnapshot {
  title: string;
  severity: IssueSeverity;
  status: Issue["status"];
  primaryCategory: IssueCategory | null;
  primarySourceKind: ObservationSourceKind | null;
  sourceKinds: ObservationSourceKind[];
  summary: string;
  rootCause: string | null;
  plan: IssuePlan;
}

const truncateTitle = (value: string, maxChars = 120) => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
};

const getPrimaryDiagnostic = (diagnostics: IssueDiagnosticDraft[]) => {
  return rankIssueDiagnostics(diagnostics)[0] ?? null;
};

const pickPrimaryCategory = (diagnostics: IssueDiagnosticDraft[]) => {
  return getPrimaryDiagnostic(diagnostics)?.category ?? null;
};

const pickPrimarySourceKind = (observations: IssueObservation[]) => {
  return observations.at(-1)?.sourceKind ?? null;
};

const buildFallbackSeverity = ({
  diagnostics,
  observations,
}: {
  diagnostics: IssueDiagnosticDraft[];
  observations: IssueObservation[];
}): IssueSeverity => {
  const hasProductionObservation = observations.some(
    (observation) => observation.context.environment === "production"
  );
  const hasCriticalCategory = diagnostics.some((diagnostic) =>
    ["security", "infrastructure", "runtime"].includes(
      diagnostic.category ?? "unknown"
    )
  );
  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  ).length;

  if (hasProductionObservation || hasCriticalCategory) {
    return "important";
  }

  if (errorCount > 0) {
    return "medium";
  }

  return "low";
};

const buildFallbackPlan = ({
  diagnostics,
  observations,
}: {
  diagnostics: IssueDiagnosticDraft[];
  observations: IssueObservation[];
}): IssuePlan => {
  const primary = getPrimaryDiagnostic(diagnostics);
  const command = observations
    .map((observation) => observation.context.command)
    .find(Boolean);
  const location = primary?.filePath
    ? `${primary.filePath}${primary.line ? `:${primary.line}` : ""}`
    : (primary?.source ?? "the captured evidence");

  return {
    summary: `Start with ${location}. Confirm the failure, apply the smallest safe fix, then re-run the same flow.`,
    steps: [
      `Inspect ${location} and compare it with the attached evidence.`,
      `Fix the root cause behind ${primary?.message ?? "the primary failure"}.`,
      command
        ? `Re-run ${command}.`
        : "Re-run the failing workflow or request.",
    ],
    validation: [
      command
        ? `${command} completes without the same failure.`
        : "The same workflow or request completes without the same failure.",
      "No new high-severity diagnostics appear after the fix.",
    ],
    blockers: [],
  };
};

const normalizePlanItems = (items: string[], fallbackItems: string[]) => {
  const normalized = items.map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : fallbackItems;
};

const toSafeSynthesisErrorLog = (error: unknown) => {
  if (!(error instanceof Error)) {
    return { name: "UnknownThrownValue" };
  }

  return {
    name: error.name,
    message:
      scrubFilePath(scrubSecrets(error.message))?.slice(0, 300) ??
      "Unknown error.",
  };
};

const buildFallbackSummary = ({
  diagnostics,
  observations,
}: {
  diagnostics: IssueDiagnosticDraft[];
  observations: IssueObservation[];
}) => {
  const primary = getPrimaryDiagnostic(diagnostics);
  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  ).length;
  const warningCount = diagnostics.length - errorCount;
  const sourceKinds = normalizeSourceKinds(
    observations.map((observation) => observation.sourceKind)
  );

  if (!primary) {
    return "This issue needs more evidence before ObsR can produce a reliable plan.";
  }

  const location = primary.filePath
    ? ` in ${primary.filePath}${primary.line ? `:${primary.line}` : ""}`
    : "";

  return `${errorCount} error${errorCount === 1 ? "" : "s"} and ${warningCount} warning${warningCount === 1 ? "" : "s"} across ${sourceKinds.join(", ")}. Start with ${primary.message}${location}.`;
};

const buildFallbackTitle = ({
  diagnostics,
  observations,
}: {
  diagnostics: IssueDiagnosticDraft[];
  observations: IssueObservation[];
}) => {
  const primary = getPrimaryDiagnostic(diagnostics);
  const sourceKind = pickPrimarySourceKind(observations) ?? "issue";

  if (!primary) {
    return "Unclassified issue";
  }

  return truncateTitle(`${primary.source ?? sourceKind}: ${primary.message}`);
};

export const synthesizeIssueSnapshot = async ({
  diagnostics,
  observations,
  relatedIssues,
  promptCacheKey,
  safetyIdentifier,
  provider = responsesIssueSynthesisProvider,
}: {
  diagnostics: IssueDiagnosticDraft[];
  observations: IssueObservation[];
  relatedIssues: RelatedIssue[];
  promptCacheKey?: string;
  safetyIdentifier?: string;
  provider?: IssueSynthesisProvider;
}): Promise<IssueSnapshot> => {
  const primaryCategory = pickPrimaryCategory(diagnostics);
  const primarySourceKind = pickPrimarySourceKind(observations);
  const sourceKinds = normalizeSourceKinds(
    observations.map((observation) => observation.sourceKind)
  );
  const fallback: IssueSnapshot = {
    title: buildFallbackTitle({
      diagnostics,
      observations,
    }),
    severity: buildFallbackSeverity({
      diagnostics,
      observations,
    }),
    status: "open",
    primaryCategory,
    primarySourceKind,
    sourceKinds,
    summary: buildFallbackSummary({
      diagnostics,
      observations,
    }),
    rootCause: getPrimaryDiagnostic(diagnostics)?.message ?? null,
    plan: buildFallbackPlan({
      diagnostics,
      observations,
    }),
  };

  try {
    const synthesis = await provider.synthesize({
      diagnostics,
      observations,
      relatedIssues,
      promptCacheKey,
      safetyIdentifier,
    });

    if (!synthesis) {
      return fallback;
    }

    return {
      title: synthesis.title.trim() || fallback.title,
      severity: synthesis.severity,
      status: "open",
      primaryCategory,
      primarySourceKind,
      sourceKinds,
      summary: synthesis.summary.trim() || fallback.summary,
      rootCause: synthesis.rootCause?.trim() || fallback.rootCause,
      plan: {
        summary: synthesis.plan.summary.trim() || fallback.plan.summary,
        steps: normalizePlanItems(synthesis.plan.steps, fallback.plan.steps),
        validation: normalizePlanItems(
          synthesis.plan.validation,
          fallback.plan.validation
        ),
        blockers: normalizePlanItems(
          synthesis.plan.blockers,
          fallback.plan.blockers
        ),
      },
    };
  } catch (error) {
    if (isResponsesRequestError(error) && error.retryable) {
      throw error;
    }

    console.error("[obsr-synthesis]", toSafeSynthesisErrorLog(error));
    return fallback;
  }
};
