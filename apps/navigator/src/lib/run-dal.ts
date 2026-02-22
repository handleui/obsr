import "server-only";

import { type CodeSnippet, runErrorOps, runOps } from "@detent/db";
import { scrubSecrets } from "@detent/types";
import { redirect } from "next/navigation";
import { cache } from "react";
import type {
  ErrorDetailData,
  RunData,
  SourceLine,
} from "@/components/features/checks/lib/types";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { getConvexClient } from "./convex-client";
import { type ProjectData, verifySession } from "./dal";
import { getNeonDb } from "./neon";
import { getWorkOSAccessToken } from "./workos-session";

type Category = "Error" | "Warning" | "Info";

interface HealDoc {
  _id: string;
  status: string;
  errorIds?: string[] | null;
  signatureIds?: string[] | null;
  patch?: string | null;
}

interface JobDoc {
  name: string;
  status: string;
  conclusion?: string | null;
  commitSha: string;
  headBranch?: string | null;
  errorCount: number;
  hasDetent: boolean;
  providerJobId: string;
}

type RunRow = NonNullable<Awaited<ReturnType<typeof runOps.getById>>>;
type RunErrorRow = Awaited<ReturnType<typeof runErrorOps.listByRunId>>[number];

const ERROR_CATEGORIES = new Set(["error", "fatal", "critical"]);
const WARNING_CATEGORIES = new Set(["warning", "warn"]);
const INFO_CATEGORIES = new Set(["info", "note", "notice", "suggestion"]);

const mapCategory = (
  category: string | null,
  severity: string | null
): Category => {
  const raw = (category ?? severity ?? "error").toLowerCase();
  if (ERROR_CATEGORIES.has(raw)) {
    return "Error";
  }
  if (WARNING_CATEGORIES.has(raw)) {
    return "Warning";
  }
  if (INFO_CATEGORIES.has(raw)) {
    return "Info";
  }
  return "Error";
};

const STATUS_PRIORITY: Record<string, number> = {
  applied: 6,
  completed: 5,
  running: 4,
  pending: 3,
  found: 2,
  rejected: 1,
  failed: 0,
};

const HEAL_STATUS_DISPLAY: Record<string, string> = {
  applied: "Healed",
  completed: "Fixed",
  running: "Healing",
  pending: "Healing",
  found: "Found",
  rejected: "Found",
  failed: "Found",
};

const deriveErrorStatus = (
  errorId: string,
  signatureId: string | null,
  heals: HealDoc[]
): string => {
  let best: HealDoc | null = null;
  let bestPriority = -1;

  for (const h of heals) {
    const matchesError = h.errorIds?.includes(errorId) ?? false;
    const matchesSig = signatureId
      ? (h.signatureIds?.includes(signatureId) ?? false)
      : false;
    if (!(matchesError || matchesSig)) {
      continue;
    }

    const priority = STATUS_PRIORITY[h.status] ?? 0;
    if (priority > bestPriority) {
      best = h;
      bestPriority = priority;
    }
  }

  if (!best) {
    return "Found";
  }
  return HEAL_STATUS_DISPLAY[best.status] ?? "Found";
};

const findHealPatch = (
  errorId: string,
  signatureId: string | null,
  heals: HealDoc[]
): string | undefined => {
  let appliedPatch: string | undefined;
  let completedPatch: string | undefined;

  for (const h of heals) {
    if (!h.patch) {
      continue;
    }
    const matchesError = h.errorIds?.includes(errorId) ?? false;
    const matchesSig = signatureId
      ? (h.signatureIds?.includes(signatureId) ?? false)
      : false;
    if (!(matchesError || matchesSig)) {
      continue;
    }

    if (h.status === "applied") {
      appliedPatch = h.patch;
      break;
    }
    if (h.status === "completed" && !completedPatch) {
      completedPatch = h.patch;
    }
  }

  return appliedPatch ?? completedPatch;
};

const JOB_STATUS_WAITING: Record<string, string> = {
  queued: "waiting",
  waiting: "waiting",
  in_progress: "waiting",
  pending: "waiting",
  requested: "waiting",
};

const ACTIVE_HEAL_STATUSES = new Set(["pending", "running", "found"]);

const healMatchesError = (heal: HealDoc, err: RunErrorRow): boolean => {
  const matchesError = heal.errorIds?.includes(err.id) ?? false;
  const matchesSig = err.signatureId
    ? (heal.signatureIds?.includes(err.signatureId) ?? false)
    : false;
  return matchesError || matchesSig;
};

const hasActiveHealForErrors = (
  errors: RunErrorRow[],
  heals: HealDoc[]
): boolean => {
  const activeHeals = heals.filter((h) => ACTIVE_HEAL_STATUSES.has(h.status));
  return errors.some((err) =>
    activeHeals.some((h) => healMatchesError(h, err))
  );
};

const mapJobStatus = (
  job: JobDoc,
  errorsByJob: Map<string, RunErrorRow[]>,
  heals: HealDoc[]
): string => {
  if (job.status !== "completed") {
    return JOB_STATUS_WAITING[job.status] ?? "waiting";
  }

  if (job.conclusion === "success") {
    return "successful";
  }
  if (job.conclusion === "skipped" || job.conclusion === "cancelled") {
    return "skipped";
  }

  const jobErrors = errorsByJob.get(job.name);
  if (jobErrors?.length && hasActiveHealForErrors(jobErrors, heals)) {
    return "healing";
  }

  return "failed";
};

const mapCodeSnippet = (
  snippet: CodeSnippet | null | undefined
): { sourceLines?: SourceLine[]; faultyLineNumbers?: number[] } => {
  if (!snippet?.lines?.length) {
    return {};
  }

  const allLines = snippet.lines.join("\n");
  const scrubbed = scrubSecrets(allLines);
  const scrubbedLines = scrubbed.split("\n");

  const sourceLines: SourceLine[] = scrubbedLines.map((content, i) => ({
    lineNumber: snippet.startLine + i,
    content,
  }));

  const faultyLineNumbers = snippet.errorLine ? [snippet.errorLine] : undefined;

  return { sourceLines, faultyLineNumbers };
};

const ERROR_TYPE_LABELS: Record<string, string> = {
  typescript: "Typescript",
  tsc: "Typescript",
  eslint: "ESLint",
  biome: "Biome",
  vitest: "Vitest",
  jest: "Jest",
  nextjs: "Next.js",
  "next.js": "Next.js",
  webpack: "Webpack",
  vite: "Vite",
  rust: "Rust",
  cargo: "Cargo",
  python: "Python",
};

const mapErrorType = (source: string | null): string => {
  if (!source) {
    return "Unknown";
  }
  return ERROR_TYPE_LABELS[source.toLowerCase()] ?? source;
};

const buildLocation = (
  filePath: string | null,
  line: number | null,
  column: number | null
): string => {
  if (!filePath) {
    return "Unknown";
  }
  let loc = filePath;
  if (line != null) {
    loc += `:${line}`;
    if (column != null) {
      loc += `:${column}`;
    }
  }
  return loc;
};

const mapError = (err: RunErrorRow, heals: HealDoc[]): ErrorDetailData => {
  const status = deriveErrorStatus(err.id, err.signatureId, heals);
  const { sourceLines, faultyLineNumbers } = mapCodeSnippet(err.codeSnippet);
  const diff =
    status === "Fixed" || status === "Healed"
      ? findHealPatch(err.id, err.signatureId, heals)
      : undefined;

  return {
    id: err.id,
    jobKey: err.workflowJob ?? "unknown",
    category: mapCategory(err.category, err.severity),
    location: buildLocation(err.filePath, err.line, err.column),
    message: scrubSecrets(err.message),
    origin: err.workflowJob ? `CI / ${err.workflowJob}` : "CI",
    errorType: mapErrorType(err.source),
    status,
    diff: diff ? scrubSecrets(diff) : undefined,
    filename: err.filePath ? err.filePath.split("/").pop() : undefined,
    sourceLines,
    faultyLineNumbers,
  };
};

const groupErrorsByJob = (
  errors: RunErrorRow[]
): Map<string, RunErrorRow[]> => {
  const map = new Map<string, RunErrorRow[]>();
  for (const err of errors) {
    const key = err.workflowJob ?? "unknown";
    const list = map.get(key);
    if (list) {
      list.push(err);
    } else {
      map.set(key, [err]);
    }
  }
  return map;
};

const isNextRedirect = (error: unknown): boolean =>
  error instanceof Error &&
  "digest" in error &&
  String((error as { digest?: string }).digest).includes("NEXT_REDIRECT");

const getAuthedConvexClient = cache(async () => {
  const accessToken = await getWorkOSAccessToken();
  if (!accessToken) {
    redirect("/login");
  }
  return getConvexClient(accessToken);
});

const MAX_PR_NUMBER = 2_147_483_647;

const isValidPrInput = (
  projectId: string,
  prNumber: number,
  project: ProjectData
): boolean => {
  if (!projectId || typeof projectId !== "string") {
    return false;
  }
  if (!Number.isInteger(prNumber) || prNumber < 1 || prNumber > MAX_PR_NUMBER) {
    return false;
  }
  return project.id === projectId;
};

const fetchRunWithRelatedData = async (
  projectId: string,
  prNumber: number,
  run: RunRow
) => {
  const { db } = getNeonDb();
  const convex = await getAuthedConvexClient();
  const typedProjectId = projectId as Id<"projects">;

  return Promise.all([
    runErrorOps.listByRunId(db, run.id, 500),
    run.commitSha
      ? (convex.query(api.jobs.listByRepoCommit, {
          repository: run.repository,
          commitSha: run.commitSha,
        }) as Promise<JobDoc[]>)
      : ([] as JobDoc[]),
    convex.query(api.heals.getByPr, {
      projectId: typedProjectId,
      prNumber,
    }) as Promise<HealDoc[]>,
  ]);
};

const buildRunData = (
  orgLogin: string,
  project: ProjectData,
  prNumber: number,
  run: RunRow,
  runErrors: RunErrorRow[],
  jobs: JobDoc[],
  heals: HealDoc[]
): RunData => {
  const errorsByJob = groupErrorsByJob(runErrors);

  return {
    org: orgLogin,
    project: project.handle,
    pr: String(prNumber),
    title: `PR #${prNumber}`,
    author: "",
    branch: {
      source: run.headBranch ?? "unknown",
      target: project.provider_default_branch ?? "main",
    },
    files: 0,
    additions: 0,
    deletions: 0,
    description: "",
    jobs: jobs.map((job) => ({
      key: job.name,
      status: mapJobStatus(job, errorsByJob, heals),
    })),
    errors: runErrors.map((err) => mapError(err, heals)),
  };
};

export const fetchPrRunData = cache(
  async (
    projectId: string,
    prNumber: number,
    project: ProjectData,
    orgLogin: string
  ): Promise<RunData | null> => {
    try {
      if (!isValidPrInput(projectId, prNumber, project)) {
        return null;
      }

      await verifySession();

      const { db } = getNeonDb();
      const run = await runOps.getLatestByProjectPr(db, projectId, prNumber);
      if (!run) {
        return null;
      }

      const [runErrors, jobs, heals] = await fetchRunWithRelatedData(
        projectId,
        prNumber,
        run
      );

      return buildRunData(
        orgLogin,
        project,
        prNumber,
        run,
        runErrors,
        jobs,
        heals
      );
    } catch (error) {
      if (isNextRedirect(error)) {
        throw error;
      }
      return null;
    }
  }
);
