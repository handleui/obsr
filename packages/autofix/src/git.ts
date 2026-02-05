// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as core from "@actions/core";
// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as exec from "@actions/exec";

const SECRET_PATTERNS = [
  [/ghp_[a-zA-Z0-9]{36}/g, "[REDACTED_TOKEN]"],
  [/gho_[a-zA-Z0-9]{36}/g, "[REDACTED_TOKEN]"],
  [/github_pat_[a-zA-Z0-9_]{22,}/g, "[REDACTED_TOKEN]"],
  [/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED]"],
  [/token\s*[=:]\s*['"]?[a-zA-Z0-9._-]+['"]?/gi, "token=[REDACTED]"],
] as const;

const redactSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text
  );

const sanitizeErrorMessage = (error: unknown, operation: string): string => {
  if (error instanceof Error) {
    return `${operation} failed: ${redactSecrets(error.message)}`;
  }
  return `${operation} failed`;
};

export const hasChanges = async (): Promise<boolean> => {
  try {
    core.debug("Checking for uncommitted changes...");
    const output = await exec.getExecOutput("git", ["status", "--porcelain"], {
      silent: !core.isDebug(),
    });
    const hasUncommittedChanges = output.stdout.trim().length > 0;
    core.debug(`Has uncommitted changes: ${hasUncommittedChanges}`);
    return hasUncommittedChanges;
  } catch (error) {
    const message = sanitizeErrorMessage(error, "git status");
    core.error(message);
    throw new Error(message);
  }
};

export const getChangedFiles = async (): Promise<string[]> => {
  try {
    core.debug("Getting list of changed files...");
    const output = await exec.getExecOutput("git", ["diff", "--name-only"], {
      silent: !core.isDebug(),
    });
    const files = output.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    core.debug(`Changed files: ${files.join(", ") || "(none)"}`);
    return files;
  } catch (error) {
    const message = sanitizeErrorMessage(error, "git diff");
    core.error(message);
    throw new Error(message);
  }
};

export const stageAll = async (): Promise<void> => {
  try {
    core.debug("Staging all changes...");
    await exec.exec("git", ["add", "-A"], {
      silent: !core.isDebug(),
    });
    core.debug("All changes staged");
  } catch (error) {
    const message = sanitizeErrorMessage(error, "git add");
    core.error(message);
    throw new Error(message);
  }
};

export const commit = async (commitMsg: string): Promise<boolean> => {
  try {
    core.debug(`Creating commit with message: "${commitMsg}"`);
    const exitCode = await exec.exec("git", ["commit", "-m", commitMsg], {
      ignoreReturnCode: true,
      silent: !core.isDebug(),
    });
    const success = exitCode === 0;
    core.debug(
      `Commit ${success ? "succeeded" : "failed (no changes or error)"}`
    );
    return success;
  } catch (error) {
    const message = sanitizeErrorMessage(error, "git commit");
    core.error(message);
    throw new Error(message);
  }
};

export const push = async (): Promise<void> => {
  try {
    core.debug("Pushing changes to remote...");
    await exec.exec("git", ["push"], {
      silent: !core.isDebug(),
    });
    core.debug("Push completed");
  } catch (error) {
    const msg = sanitizeErrorMessage(error, "git push");
    core.error(msg);
    throw new Error(msg);
  }
};

export const configureGit = async (): Promise<void> => {
  try {
    core.debug("Configuring git user for commits...");
    await exec.exec("git", ["config", "user.name", "github-actions[bot]"], {
      silent: !core.isDebug(),
    });
    await exec.exec(
      "git",
      ["config", "user.email", "github-actions[bot]@users.noreply.github.com"],
      { silent: !core.isDebug() }
    );
    core.debug("Git user configured");
  } catch (error) {
    const message = sanitizeErrorMessage(error, "git config");
    core.error(message);
    throw new Error(message);
  }
};
