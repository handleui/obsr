import type { IssueIngestInput } from "@/lib/issues/schema";
import type {
  VercelDeployment,
  VercelDeploymentEvent,
  VercelRuntimeLog,
} from "./client";

interface VercelTargetContext {
  projectId: string;
  projectName?: string | null;
  repo?: string | null;
  teamId: string;
}

const getDeploymentId = (deployment: VercelDeployment) => {
  return deployment.uid ?? deployment.id ?? null;
};

const toCapturedAt = (value?: number | string) => {
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
};

const getDeploymentUrl = (deployment: VercelDeployment) => {
  if (!deployment.url) {
    return undefined;
  }

  return deployment.url.startsWith("http")
    ? deployment.url
    : `https://${deployment.url}`;
};

const getEnvironment = (deployment: VercelDeployment) => {
  if (deployment.target === "production") {
    return "production" as const;
  }

  if (deployment.target === "preview") {
    return "preview" as const;
  }

  return "unknown" as const;
};

const getAppName = (
  deployment: VercelDeployment,
  target: VercelTargetContext
) => {
  return deployment.name ?? target.projectName ?? target.projectId;
};

const getRepo = (deployment: VercelDeployment, target: VercelTargetContext) => {
  return (
    deployment.meta?.githubCommitRepo ??
    deployment.meta?.githubRepo ??
    deployment.meta?.repo ??
    target.repo ??
    undefined
  );
};

const getBranch = (deployment: VercelDeployment) => {
  return (
    deployment.meta?.githubCommitRef ??
    deployment.meta?.githubBranch ??
    undefined
  );
};

const getCommitSha = (deployment: VercelDeployment) => {
  return deployment.meta?.githubCommitSha ?? undefined;
};

const eventToText = (event: VercelDeploymentEvent) => {
  if (typeof event.text === "string" && event.text.trim()) {
    return event.text.trim();
  }

  if (typeof event.payload?.text === "string" && event.payload.text.trim()) {
    return event.payload.text.trim();
  }

  if (
    typeof event.payload?.name === "string" &&
    typeof event.payload?.text === "string"
  ) {
    return `${event.payload.name}: ${event.payload.text}`.trim();
  }

  if (
    typeof event.payload?.message === "string" &&
    event.payload.message.trim()
  ) {
    return event.payload.message.trim();
  }

  return null;
};

const buildBaseContext = (
  deployment: VercelDeployment,
  target: VercelTargetContext
) => {
  const deploymentId = getDeploymentId(deployment);

  return {
    app: getAppName(deployment, target),
    branch: getBranch(deployment),
    commitSha: getCommitSha(deployment),
    environment: getEnvironment(deployment),
    externalId: deploymentId ?? undefined,
    externalUrl: getDeploymentUrl(deployment),
    provider: "vercel",
    repo: getRepo(deployment, target),
  };
};

const groupRuntimeLogs = (logs: VercelRuntimeLog[]) => {
  const groups = new Map<string, VercelRuntimeLog[]>();

  for (const [index, log] of logs.entries()) {
    const key =
      log.requestId?.trim() ||
      log.rowId?.trim() ||
      `${log.timestampInMs ?? "unknown"}:${index}`;

    const existing = groups.get(key) ?? [];
    existing.push(log);
    groups.set(key, existing);
  }

  return [...groups.entries()];
};

export const normalizeBuildObservation = ({
  deployment,
  events,
  target,
}: {
  deployment: VercelDeployment;
  events: VercelDeploymentEvent[];
  target: VercelTargetContext;
}): IssueIngestInput | null => {
  const deploymentId = getDeploymentId(deployment);
  if (!deploymentId) {
    return null;
  }

  const lines = events.map(eventToText).filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  return {
    sourceKind: "ci",
    rawText: lines.join("\n"),
    rawPayload: {
      deployment,
      events,
      projectId: target.projectId,
      teamId: target.teamId,
    },
    dedupeKey: `vercel:build:${deploymentId}`,
    capturedAt: toCapturedAt(deployment.createdAt),
    context: {
      ...buildBaseContext(deployment, target),
      command: "vercel build",
    },
  };
};

export const normalizeRuntimeObservations = ({
  deployment,
  logs,
  target,
}: {
  deployment: VercelDeployment;
  logs: VercelRuntimeLog[];
  target: VercelTargetContext;
}) => {
  const deploymentId = getDeploymentId(deployment);
  if (!deploymentId) {
    return [] as IssueIngestInput[];
  }

  return groupRuntimeLogs(logs)
    .map(([groupKey, entries]) => {
      const messages = entries
        .map((entry) => entry.message?.trim())
        .filter(Boolean) as string[];

      if (messages.length === 0) {
        return null;
      }

      const firstEntry = entries[0];

      return {
        sourceKind: "runtime-log" as const,
        rawText: messages.join("\n"),
        rawPayload: {
          deployment,
          logs: entries,
          projectId: target.projectId,
          teamId: target.teamId,
        },
        dedupeKey: `vercel:runtime:${deploymentId}:${groupKey}`,
        capturedAt: toCapturedAt(
          firstEntry?.timestampInMs ?? deployment.createdAt
        ),
        context: {
          ...buildBaseContext(deployment, target),
          route: firstEntry?.requestPath ?? undefined,
        },
      };
    })
    .filter(Boolean) as IssueIngestInput[];
};

export const shouldFetchBuildLogs = (deployment: VercelDeployment) => {
  const state = deployment.readyState ?? deployment.state ?? "";
  return ["CANCELED", "ERROR", "FAILED"].includes(state.toUpperCase());
};

export const shouldFetchRuntimeLogs = (deployment: VercelDeployment) => {
  const state = deployment.readyState ?? deployment.state ?? "";
  return ["ERROR", "READY"].includes(state.toUpperCase());
};
