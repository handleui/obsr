import { MAX_BRIEF_DIAGNOSTICS } from "./constants";
import type { IssueDetail } from "./schema";

const formatLocation = (filePath: string | null, line: number | null) => {
  if (!filePath) {
    return null;
  }

  return `${filePath}${line ? `:${line}` : ""}`;
};

export const buildIssueBrief = (issue: Omit<IssueDetail, "brief">) => {
  const diagnostics = issue.diagnostics
    .slice(0, MAX_BRIEF_DIAGNOSTICS)
    .map((diagnostic, index) => {
      const location = formatLocation(diagnostic.filePath, diagnostic.line);
      const meta = [diagnostic.source, diagnostic.ruleId, location].filter(
        Boolean
      );

      return `${index + 1}. ${meta.length ? `[${meta.join(" | ")}] ` : ""}${diagnostic.message}`;
    });

  return [
    `Issue: ${issue.title}`,
    `Severity: ${issue.severity}`,
    "",
    "Summary:",
    issue.summary,
    "",
    "Root cause:",
    issue.rootCause ?? "Needs confirmation from the attached evidence.",
    "",
    "Plan:",
    ...issue.plan.steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Validation:",
    ...issue.plan.validation.map((step, index) => `${index + 1}. ${step}`),
    issue.plan.blockers.length > 0 ? "" : null,
    issue.plan.blockers.length > 0 ? "Blockers:" : null,
    ...issue.plan.blockers.map((step, index) => `${index + 1}. ${step}`),
    diagnostics.length > 0 ? "" : null,
    diagnostics.length > 0 ? "Top diagnostics:" : null,
    ...diagnostics,
  ]
    .filter(Boolean)
    .join("\n");
};
