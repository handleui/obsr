import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Env } from "../../env.js";
import { env } from "../../env.js";
import { getInstallationToken } from "../github/token.js";
import { executeHeal } from "../heal-executor.js";

const POLL_INTERVAL_MS = 5000;
const POOL_SIZE = 5;

interface HealRow {
  id: string;
  type: string;
  status: string;
  run_id: string | null;
  project_id: string;
  commit_sha: string | null;
  pr_number: number | null;
  check_run_id: string | null;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  provider_repo_full_name: string;
  provider_default_branch: string | null;
}

interface RunRow {
  id: string;
  commit_sha: string | null;
  head_branch: string | null;
}

interface RunErrorRow {
  id: string;
  message: string;
  file_path: string | null;
  line: number | null;
  column: number | null;
  category: string | null;
  severity: string | null;
  rule_id: string | null;
  source: string | null;
  stack_trace: string | null;
}

interface OrganizationRow {
  provider_installation_id: string | null;
}

type Database = NodePgDatabase<Record<string, never>>;

interface PollerState {
  isRunning: boolean;
  activeHealIds: Set<string>;
  dbPool: Pool | null;
}

const state: PollerState = {
  isRunning: false,
  activeHealIds: new Set(),
  dbPool: null,
};

const createDatabase = (): Database => {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: POOL_SIZE,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5000,
  });

  pool.on("error", (err) => {
    console.error(`[poller] Database pool error: ${err.message}`);
  });

  state.dbPool = pool;
  return drizzle(pool);
};

const fetchPendingHeals = async (db: Database): Promise<HealRow[]> => {
  const limit = env.MAX_CONCURRENT_HEALS - state.activeHealIds.size;
  if (limit <= 0) {
    return [];
  }

  const result = await db.execute(sql`
    SELECT id, type, status, run_id, project_id, commit_sha, pr_number, check_run_id
    FROM heals
    WHERE type = 'heal' AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT ${limit}
  `);

  return result.rows as unknown as HealRow[];
};

const markHealRunning = async (db: Database, healId: string): Promise<void> => {
  await db.execute(sql`
    UPDATE heals
    SET status = 'running', updated_at = NOW()
    WHERE id = ${healId}
  `);
};

const markHealCompleted = async (
  db: Database,
  healId: string,
  data: {
    patch: string | null;
    filesChanged: string[];
    result: {
      model: string;
      iterations: number;
      costUSD: number;
      inputTokens: number;
      outputTokens: number;
      finalMessage: string;
    };
  }
): Promise<void> => {
  const healResult = {
    model: data.result.model,
    patchApplied: false,
    verificationPassed: data.patch !== null,
    toolCalls: 0,
  };

  const costUsdCents = Math.round(data.result.costUSD * 100);

  await db.execute(sql`
    UPDATE heals
    SET
      status = 'completed',
      patch = ${data.patch},
      files_changed = ${JSON.stringify(data.filesChanged)}::jsonb,
      heal_result = ${JSON.stringify(healResult)}::jsonb,
      cost_usd = ${costUsdCents},
      input_tokens = ${data.result.inputTokens},
      output_tokens = ${data.result.outputTokens},
      updated_at = NOW()
    WHERE id = ${healId}
  `);
};

const markHealFailed = async (
  db: Database,
  healId: string,
  reason: string
): Promise<void> => {
  const truncatedReason =
    reason.length > 2000 ? `${reason.slice(0, 1997)}...` : reason;

  await db.execute(sql`
    UPDATE heals
    SET status = 'failed', failed_reason = ${truncatedReason}, updated_at = NOW()
    WHERE id = ${healId}
  `);
};

const fetchProject = async (
  db: Database,
  projectId: string
): Promise<ProjectRow | null> => {
  const result = await db.execute(sql`
    SELECT id, organization_id, provider_repo_full_name, provider_default_branch
    FROM projects
    WHERE id = ${projectId}
    LIMIT 1
  `);

  return (result.rows[0] as unknown as ProjectRow | undefined) ?? null;
};

const fetchRun = async (
  db: Database,
  runId: string
): Promise<RunRow | null> => {
  const result = await db.execute(sql`
    SELECT id, commit_sha, head_branch
    FROM runs
    WHERE id = ${runId}
    LIMIT 1
  `);

  return (result.rows[0] as unknown as RunRow | undefined) ?? null;
};

const fetchRunErrors = async (
  db: Database,
  runId: string
): Promise<RunErrorRow[]> => {
  const result = await db.execute(sql`
    SELECT id, message, file_path, line, "column", category, severity, rule_id, source, stack_trace
    FROM run_errors
    WHERE run_id = ${runId}
    ORDER BY id
  `);

  return result.rows as unknown as RunErrorRow[];
};

const fetchOrganization = async (
  db: Database,
  orgId: string
): Promise<OrganizationRow | null> => {
  const result = await db.execute(sql`
    SELECT provider_installation_id
    FROM organizations
    WHERE id = ${orgId}
    LIMIT 1
  `);

  return (result.rows[0] as unknown as OrganizationRow | undefined) ?? null;
};

const GITHUB_API = "https://api.github.com";

// Retry config loaded from environment variables (with defaults)
const getRetryConfig = () => ({
  maxRetries: env.GITHUB_API_MAX_RETRIES,
  initialDelayMs: env.GITHUB_API_INITIAL_DELAY_MS,
  backoffMultiplier: env.GITHUB_API_BACKOFF_MULTIPLIER,
});

// HTTP status codes that should not be retried (auth issues, not found, validation errors)
const NON_RETRYABLE_STATUSES = new Set([401, 403, 404, 422]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Result type for GitHub API calls with retry
type GitHubCallResult =
  | { ok: true }
  | { ok: false; retryable: false; status: number }
  | { ok: false; retryable: true; error: Error };

// Execute a single GitHub API request and categorize the result
const executeGitHubRequest = async (
  url: string,
  options: RequestInit
): Promise<GitHubCallResult> => {
  try {
    const response = await fetch(url, options);
    if (response.ok) {
      return { ok: true };
    }
    if (NON_RETRYABLE_STATUSES.has(response.status)) {
      return { ok: false, retryable: false, status: response.status };
    }
    return {
      ok: false,
      retryable: true,
      error: new Error(`HTTP ${response.status}`),
    };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

// Retry helper for GitHub API calls with exponential backoff
interface GitHubRetryParams {
  url: string;
  options: RequestInit;
  successMsg: string;
  failureMsg: string;
}

const withGitHubRetry = async (params: GitHubRetryParams): Promise<void> => {
  const { url, options, successMsg, failureMsg } = params;
  const retryConfig = getRetryConfig();
  let lastError: Error | null = null;
  let delay = retryConfig.initialDelayMs;
  const totalAttempts = retryConfig.maxRetries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const result = await executeGitHubRequest(url, options);

    if (result.ok) {
      const msg =
        attempt > 1
          ? `${successMsg} (succeeded on attempt ${attempt})`
          : successMsg;
      console.log(`[poller] ${msg}`);
      return;
    }

    if (!result.retryable) {
      console.error(
        `[poller] ${failureMsg}: HTTP ${result.status} (not retrying)`
      );
      return;
    }

    lastError = result.error;
    if (attempt < totalAttempts) {
      console.warn(
        `[poller] ${failureMsg} (attempt ${attempt}/${totalAttempts}): ${result.error.message}, retrying in ${delay}ms`
      );
      await sleep(delay);
      delay *= retryConfig.backoffMultiplier;
    }
  }

  console.error(
    `[poller] ${failureMsg} after ${totalAttempts} attempts: ${lastError?.message ?? "Unknown error"}`
  );
};

// GitHub name validation pattern (alphanumeric with hyphens, dots, underscores)
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9][-a-zA-Z0-9._]*$/;

const isValidGitHubName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 100 &&
  GITHUB_NAME_PATTERN.test(name) &&
  !name.includes("..");

const sanitizeErrorForCheckRun = (error: string): string => {
  // Remove potentially sensitive info: paths, tokens, URLs with credentials
  const sanitized = error
    .replace(/https?:\/\/[^\s]+/g, "[URL]")
    .replace(/\/[\w/.-]+/g, "[PATH]")
    .replace(/token[=:]\s*\S+/gi, "token=[REDACTED]");
  // Truncate to reasonable length for GitHub check run summary
  return sanitized.length > 500 ? `${sanitized.slice(0, 497)}...` : sanitized;
};

// ============================================================================
// PR Comment Posting
// ============================================================================
// Posts comments on PRs when heals complete or fail.
// Formatters match comment-formatter.ts in apps/api for consistent styling.

// Detent documentation URL for comment headers
const DOCS_URL = "https://detent.sh/docs";

// Format friendly header with context-specific message
// Matches formatHeader() in apps/api/src/services/comment-formatter.ts
const formatHeader = (message: string): string => {
  return `${message}\nNot sure what's happening? [Read the docs](${DOCS_URL})`;
};

// HTML entity map for escaping (prevents XSS via user-controlled content)
const HTML_TAG_PATTERN = /[<>&"']/g;
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (text: string): string => {
  return text.replace(HTML_TAG_PATTERN, (char) => HTML_ENTITIES[char] ?? char);
};

const formatHealSuccessComment = (
  filesFixed: number,
  projectId: string,
  navigatorBaseUrl: string
): string => {
  const fileText = filesFixed === 1 ? "1 file" : `${filesFixed} files`;
  const projectUrl = `${navigatorBaseUrl}/dashboard/${projectId}`;

  const lines: string[] = [];
  lines.push(formatHeader(`Healed ${fileText}. Ready to apply.`));
  lines.push("");
  lines.push(`[Review and apply in dashboard](${projectUrl})`);

  return lines.join("\n");
};

const formatHealFailedComment = (reason: string): string => {
  // Truncate and sanitize reason to prevent injection
  const safeReason =
    reason.length > 200
      ? `${escapeHtml(reason.slice(0, 197))}...`
      : escapeHtml(reason);

  const lines: string[] = [];
  lines.push(formatHeader("Failed to heal."));
  lines.push("");
  lines.push(`Reason: ${safeReason}`);

  return lines.join("\n");
};

const postPrComment = async (
  appEnv: Env,
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> => {
  // Validate inputs early (no retry for validation failures)
  if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
    console.error("[poller] Invalid owner or repo name for PR comment");
    return;
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error("[poller] Invalid PR number for comment");
    return;
  }

  const token = await getInstallationToken(appEnv, installationId);
  if (!token) {
    console.error(`[poller] No token for installation ${installationId}`);
    return;
  }

  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  const options: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Detent-Healer",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  };

  await withGitHubRetry({
    url,
    options,
    successMsg: `Posted comment on ${owner}/${repo}#${prNumber}`,
    failureMsg: "Failed to post comment",
  });
};

const updateCheckRun = async (
  appEnv: Env,
  installationId: number,
  owner: string,
  repo: string,
  checkRunId: number,
  conclusion: "success" | "failure",
  output: { title: string; summary: string }
): Promise<void> => {
  // Validate inputs early (no retry for validation failures)
  if (!(isValidGitHubName(owner) && isValidGitHubName(repo))) {
    console.error("[poller] Invalid owner or repo name for check run update");
    return;
  }
  if (!Number.isInteger(checkRunId) || checkRunId <= 0) {
    console.error("[poller] Invalid check run ID");
    return;
  }

  const token = await getInstallationToken(appEnv, installationId);
  if (!token) {
    console.error(`[poller] No token for installation ${installationId}`);
    return;
  }

  // Sanitize output summary to avoid leaking sensitive info
  const sanitizedOutput = {
    title: output.title,
    summary:
      conclusion === "failure"
        ? sanitizeErrorForCheckRun(output.summary)
        : output.summary,
  };

  const url = `${GITHUB_API}/repos/${owner}/${repo}/check-runs/${checkRunId}`;
  const options: RequestInit = {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Detent-Healer",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      status: "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output: sanitizedOutput,
    }),
  };

  await withGitHubRetry({
    url,
    options,
    successMsg: `Updated check run ${checkRunId} to ${conclusion}`,
    failureMsg: `Failed to update check run ${checkRunId}`,
  });
};

const maskSecret = (secret: string): string =>
  secret.length > 8 ? `${secret.slice(0, 4)}****` : "****";

const buildRepoUrl = (
  repoFullName: string,
  token: string | null
): { url: string; masked: string } => {
  if (token) {
    return {
      url: `https://x-access-token:${token}@github.com/${repoFullName}.git`,
      masked: `https://x-access-token:${maskSecret(token)}@github.com/${repoFullName}.git`,
    };
  }
  const publicUrl = `https://github.com/${repoFullName}.git`;
  return { url: publicUrl, masked: publicUrl };
};

const formatErrorsForPrompt = (errors: RunErrorRow[]): string => {
  if (errors.length === 0) {
    return "(no errors found)";
  }

  const formatted = errors.map((err) => {
    const location = err.file_path
      ? `${err.file_path}:${err.line ?? "-"}:${err.column ?? "-"}`
      : `line ${err.line ?? "-"}:${err.column ?? "-"}`;

    let line = `[${err.category ?? "unknown"}] ${location}: ${err.message}`;

    if (err.rule_id || err.source) {
      line += `\n  Rule: ${err.rule_id ?? "-"} | Source: ${err.source ?? "-"}`;
    }

    if (err.stack_trace) {
      const stackLines = err.stack_trace.split("\n").slice(0, 10);
      line += `\n  Stack trace:\n    ${stackLines.join("\n    ")}`;
    }

    return line;
  });

  return formatted.join("\n\n");
};

// ============================================================================
// Heal Completion Notification Helper
// ============================================================================
// Extracted helper to reduce duplication - handles both check run update and PR comment

interface NotifyHealCompletionParams {
  appEnv: Env;
  heal: HealRow;
  installationId: number | null;
  repoFullName: string | null;
  conclusion: "success" | "failure";
  checkRunOutput: { title: string; summary: string };
  prComment: string;
}

const notifyHealCompletion = async (
  params: NotifyHealCompletionParams
): Promise<void> => {
  const {
    appEnv,
    heal,
    installationId,
    repoFullName,
    conclusion,
    checkRunOutput,
    prComment,
  } = params;

  if (!(installationId && repoFullName)) {
    return;
  }

  const [owner, repo] = repoFullName.split("/");
  if (!(owner && repo)) {
    return;
  }

  // Update check run if present
  if (heal.check_run_id) {
    await updateCheckRun(
      appEnv,
      installationId,
      owner,
      repo,
      Number.parseInt(heal.check_run_id, 10),
      conclusion,
      checkRunOutput
    );
  }

  // Post PR comment if PR number present
  if (heal.pr_number) {
    await postPrComment(
      appEnv,
      installationId,
      owner,
      repo,
      heal.pr_number,
      prComment
    );
  }
};

const processHeal = async (
  db: Database,
  heal: HealRow,
  appEnv: Env
): Promise<void> => {
  console.log(`[poller] Processing heal ${heal.id}`);

  // Store for check run update at the end
  let installationId: number | null = null;
  let repoFullName: string | null = null;

  try {
    await markHealRunning(db, heal.id);

    const project = await fetchProject(db, heal.project_id);
    if (!project) {
      throw new Error(`Project ${heal.project_id} not found`);
    }

    repoFullName = project.provider_repo_full_name;
    const org = await fetchOrganization(db, project.organization_id);

    let branch = project.provider_default_branch ?? "main";
    let errors: RunErrorRow[] = [];

    if (heal.run_id) {
      const [run, runErrors] = await Promise.all([
        fetchRun(db, heal.run_id),
        fetchRunErrors(db, heal.run_id),
      ]);
      if (run) {
        branch = run.head_branch ?? branch;
      }
      errors = runErrors;
    }

    let token: string | null = null;
    if (org?.provider_installation_id) {
      installationId = Number.parseInt(org.provider_installation_id, 10);
      if (!Number.isNaN(installationId)) {
        token = await getInstallationToken(appEnv, installationId);
      }
    }

    const { url: repoUrl, masked: maskedRepoUrl } = buildRepoUrl(
      project.provider_repo_full_name,
      token
    );

    console.log(`[poller] Cloning ${maskedRepoUrl} branch ${branch}`);

    const userPrompt = `Fix the following CI errors:\n\n${formatErrorsForPrompt(errors)}`;

    const result = await executeHeal(appEnv, {
      healId: heal.id,
      repoUrl,
      branch,
      userPrompt,
      budgetPerRunUSD: 1.0,
      remainingMonthlyUSD: -1,
    });

    if (result.success) {
      await markHealCompleted(db, heal.id, {
        patch: result.patch,
        filesChanged: result.filesChanged,
        result: result.result,
      });
      console.log(`[poller] Heal ${heal.id} completed successfully`);

      await notifyHealCompletion({
        appEnv,
        heal,
        installationId,
        repoFullName,
        conclusion: "success",
        checkRunOutput: {
          title: "Healing complete",
          summary: `Found fixes for ${result.filesChanged.length} files. Review in dashboard.`,
        },
        prComment: formatHealSuccessComment(
          result.filesChanged.length,
          heal.project_id,
          appEnv.NAVIGATOR_BASE_URL
        ),
      });
    } else {
      const errorMessage = result.error ?? "Heal failed";
      await markHealFailed(db, heal.id, errorMessage);
      console.log(`[poller] Heal ${heal.id} failed: ${result.error}`);

      await notifyHealCompletion({
        appEnv,
        heal,
        installationId,
        repoFullName,
        conclusion: "failure",
        checkRunOutput: {
          title: "Healing failed",
          summary: errorMessage,
        },
        prComment: formatHealFailedComment(errorMessage),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[poller] Error processing heal ${heal.id}: ${message}`);
    await markHealFailed(db, heal.id, message);

    await notifyHealCompletion({
      appEnv,
      heal,
      installationId,
      repoFullName,
      conclusion: "failure",
      checkRunOutput: {
        title: "Healing failed",
        summary: message,
      },
      prComment: formatHealFailedComment(message),
    });
  }
};

const pollLoop = async (db: Database, appEnv: Env): Promise<void> => {
  while (state.isRunning) {
    try {
      const pendingHeals = await fetchPendingHeals(db);

      for (const heal of pendingHeals) {
        if (!state.isRunning) {
          break;
        }

        // Skip if already being processed (prevents double-processing on fast polls)
        if (state.activeHealIds.has(heal.id)) {
          continue;
        }

        // Track the heal ID before starting (atomic add)
        state.activeHealIds.add(heal.id);

        // Process asynchronously with proper cleanup
        processHeal(db, heal, appEnv)
          .catch((err) => {
            // Log unhandled errors from processHeal (shouldn't happen as it has its own try/catch)
            console.error(
              `[poller] Unhandled error in processHeal: ${err instanceof Error ? err.message : String(err)}`
            );
          })
          .finally(() => {
            // Always remove from active set when done
            state.activeHealIds.delete(heal.id);
          });
      }
    } catch (error) {
      console.error(
        `[poller] Poll loop error: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
};

interface StaleHealRow {
  id: string;
  check_run_id: string | null;
  project_id: string;
}

const markStaleHealsAsFailed = async (
  db: Database,
  appEnv: Env
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stale heal processing requires multiple DB queries and GitHub API calls
): Promise<void> => {
  try {
    // Get stale heals with their check_run_id and project_id for GitHub updates
    const result = await db.execute(sql`
      UPDATE heals
      SET
        status = 'failed',
        failed_reason = 'Heal timed out',
        updated_at = NOW()
      WHERE
        type = 'heal'
        AND status IN ('pending', 'running')
        AND updated_at < NOW() - INTERVAL '30 minutes'
      RETURNING id, check_run_id, project_id
    `);

    const staleHeals = result.rows as unknown as StaleHealRow[];

    if (staleHeals.length === 0) {
      return;
    }

    console.log(`[poller] Marked ${staleHeals.length} stale heals as failed`);

    // Update GitHub check runs for stale heals to avoid orphaned "in_progress" status
    for (const heal of staleHeals) {
      if (!heal.check_run_id) {
        continue;
      }

      try {
        const project = await fetchProject(db, heal.project_id);
        if (!project) {
          continue;
        }

        const org = await fetchOrganization(db, project.organization_id);
        if (!org?.provider_installation_id) {
          continue;
        }

        const installationId = Number.parseInt(
          org.provider_installation_id,
          10
        );
        if (Number.isNaN(installationId)) {
          continue;
        }

        const [owner, repo] = project.provider_repo_full_name.split("/");
        if (!(owner && repo)) {
          continue;
        }

        await updateCheckRun(
          appEnv,
          installationId,
          owner,
          repo,
          Number.parseInt(heal.check_run_id, 10),
          "failure",
          {
            title: "Healing timed out",
            summary: "The heal operation exceeded the 30 minute timeout limit.",
          }
        );

        console.log(
          `[poller] Updated stale check run ${heal.check_run_id} for heal ${heal.id}`
        );
      } catch (error) {
        // Log but don't fail the overall operation
        console.error(
          `[poller] Failed to update stale check run for heal ${heal.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } catch (error) {
    console.error(
      `[poller] Error marking stale heals: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const startPoller = async (): Promise<void> => {
  if (state.isRunning) {
    console.warn("[poller] Already running");
    return;
  }

  console.log("[poller] Starting...");

  try {
    const db = createDatabase();
    state.isRunning = true;

    await markStaleHealsAsFailed(db, env);

    pollLoop(db, env).catch((err) => {
      console.error(
        `[poller] Fatal error: ${err instanceof Error ? err.message : String(err)}`
      );
      state.isRunning = false;
    });

    console.log("[poller] Started successfully");
  } catch (error) {
    console.error(
      `[poller] Failed to start: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
};

export const stopPoller = async (): Promise<void> => {
  if (!state.isRunning) {
    return;
  }

  console.log("[poller] Stopping...");
  state.isRunning = false;

  while (state.activeHealIds.size > 0) {
    console.log(
      `[poller] Waiting for ${state.activeHealIds.size} active heals to complete`
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (state.dbPool) {
    await state.dbPool.end();
    state.dbPool = null;
  }

  console.log("[poller] Stopped");
};
