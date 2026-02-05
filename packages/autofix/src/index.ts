// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as core from "@actions/core";
import { runAllAutofixes } from "./executor.js";
import {
  commit,
  configureGit,
  getChangedFiles,
  hasChanges,
  push,
  stageAll,
} from "./git.js";
import { detectConfiguredTools } from "./registry.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally matching control chars for security sanitization
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const DEFAULT_COMMIT_MESSAGE = "chore: autofix lint/format issues";
const MAX_COMMIT_LENGTH = 500;

const sanitizeCommitMessage = (message: string): string => {
  if (!message?.trim()) {
    return DEFAULT_COMMIT_MESSAGE;
  }

  const sanitized = message.replace(CONTROL_CHARS_REGEX, "").trim();
  if (!sanitized) {
    return DEFAULT_COMMIT_MESSAGE;
  }

  return sanitized.length > MAX_COMMIT_LENGTH
    ? sanitized.slice(0, MAX_COMMIT_LENGTH)
    : sanitized;
};

const setNoChangesOutput = (): void => {
  core.setOutput("files-changed", "0");
  core.setOutput("committed", "false");
  core.saveState("files-changed", "0");
  core.saveState("committed", "false");
};

const setCommitOutput = (committed: boolean, filesChanged: string): void => {
  core.setOutput("files-changed", filesChanged);
  core.setOutput("committed", String(committed));
  core.saveState("files-changed", filesChanged);
  core.saveState("committed", String(committed));
};

const run = async (): Promise<void> => {
  try {
    const rawCommitMessage = core.getInput("commit-message");
    const commitMessage = sanitizeCommitMessage(rawCommitMessage);
    const autoCommit = core.getBooleanInput("auto-commit");

    core.debug(
      `Configuration: commit-message="${commitMessage}", auto-commit=${autoCommit}`
    );
    core.info("Detecting configured linting and formatting tools...");
    const tools = detectConfiguredTools();

    const toolNames = tools.map((t) => t.source);
    core.setOutput("tools-detected", toolNames.join(","));

    if (tools.length === 0) {
      core.info("No supported linting/formatting tools detected");
      setNoChangesOutput();
      return;
    }

    core.info(`Detected tools: ${toolNames.join(", ")}`);

    await runAllAutofixes(tools);

    const hasAnyChanges = await hasChanges();

    if (!hasAnyChanges) {
      core.info("No changes to commit");
      setNoChangesOutput();
      return;
    }

    const changedFiles = await getChangedFiles();
    const filesChangedCount = String(changedFiles.length);
    core.info(`${changedFiles.length} file(s) modified`);

    if (!autoCommit) {
      core.info("Auto-commit disabled, skipping commit");
      setCommitOutput(false, filesChangedCount);
      return;
    }

    core.info("Committing changes...");
    await configureGit();
    await stageAll();
    const didCommit = await commit(commitMessage);

    if (didCommit) {
      core.info("Pushing changes...");
      await push();
      core.info("Changes committed and pushed successfully");
    } else {
      core.info("No changes were committed");
    }

    setCommitOutput(didCommit, filesChangedCount);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(errorMessage);
    if (error instanceof Error && error.stack) {
      core.debug(error.stack);
    }
  }
};

run();
