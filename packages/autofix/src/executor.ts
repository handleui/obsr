// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as core from "@actions/core";
// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as exec from "@actions/exec";
import { hasChanges } from "./git.js";
import type { AutofixConfig } from "./registry.js";
import { isCommandAllowed } from "./registry.js";

export interface AutofixResult {
  source: string;
  success: boolean;
  hadChanges: boolean;
  error?: string;
}

const WHITESPACE_REGEX = /\s+/;

// Security: Parse command into executable and arguments
// This prevents shell interpretation of metacharacters
const parseCommand = (command: string): { cmd: string; args: string[] } => {
  const parts = command.split(WHITESPACE_REGEX).filter((p) => p.length > 0);
  const [cmd, ...args] = parts;
  if (!cmd) {
    throw new Error("Empty command");
  }
  return { cmd, args };
};

export const runAutofix = async (
  config: AutofixConfig
): Promise<AutofixResult> => {
  const { source, command } = config;

  // Security: validate command is in allowlist
  if (!isCommandAllowed(command)) {
    core.warning(
      `Command not in allowlist: ${command}. Skipping autofix for ${source}.`
    );
    return {
      source,
      success: false,
      hadChanges: false,
      error: `Command not allowed: ${command}`,
    };
  }

  // Use group to create collapsible log section for each tool
  return await core.group(`Running ${source}: ${command}`, async () => {
    // Security: Parse command into executable + args to avoid shell interpretation
    const { cmd, args } = parseCommand(command);
    core.debug(`Executing: ${cmd} ${args.join(" ")}`);

    // Run the autofix command with separated args (no shell parsing)
    // Output is shown so users can see what changes the linter made (wrapped in collapsible group)
    const exitCode = await exec.exec(cmd, args, {
      ignoreReturnCode: true,
    });

    if (exitCode !== 0) {
      core.warning(
        `Autofix command for ${source} exited with code ${exitCode}`
      );
      return {
        source,
        success: false,
        hadChanges: false,
        error: `Command exited with code ${exitCode}`,
      };
    }

    // Check if any files changed
    const hadChanges = await hasChanges();

    if (hadChanges) {
      core.info(`Autofix for ${source} made changes`);
    } else {
      core.info(`Autofix for ${source} made no changes`);
    }

    return {
      source,
      success: true,
      hadChanges,
    };
  });
};

interface ResultStats {
  successful: number;
  withChanges: AutofixResult[];
  failed: AutofixResult[];
}

const collectStats = (results: AutofixResult[]): ResultStats => {
  const stats: ResultStats = { successful: 0, withChanges: [], failed: [] };
  for (const r of results) {
    if (r.success) {
      stats.successful++;
    }
    if (r.hadChanges) {
      stats.withChanges.push(r);
    }
    if (!r.success) {
      stats.failed.push(r);
    }
  }
  return stats;
};

const writeJobSummary = async (results: AutofixResult[]): Promise<void> => {
  await core.summary
    .addHeading("Autofix Results", 2)
    .addTable([
      [
        { data: "Tool", header: true },
        { data: "Status", header: true },
        { data: "Changes", header: true },
      ],
      ...results.map((r) => [
        r.source,
        r.success ? "Success" : `Failed: ${r.error ?? "Unknown error"}`,
        r.hadChanges ? "Yes" : "No",
      ]),
    ])
    .write();
};

const logResultAnnotations = (stats: ResultStats): void => {
  if (stats.withChanges.length > 0) {
    core.notice(
      `Autofix applied changes from ${stats.withChanges.length} tool(s): ${stats.withChanges.map((r) => r.source).join(", ")}`,
      { title: "Autofix Applied" }
    );
  }

  for (const result of stats.failed) {
    core.error(`Autofix failed for ${result.source}: ${result.error}`, {
      title: `${result.source} Failed`,
    });
  }
};

export const runAllAutofixes = async (
  configs: AutofixConfig[]
): Promise<AutofixResult[]> => {
  const results: AutofixResult[] = [];
  // Sequential execution: tools may modify overlapping files (e.g., biome and prettier
  // both touching .ts files), so parallel execution could cause race conditions
  for (const config of configs) {
    results.push(await runAutofix(config));
  }

  const stats = collectStats(results);
  core.info(
    `Autofix summary: ${stats.successful}/${results.length} succeeded, ${stats.withChanges.length} made changes`
  );

  await writeJobSummary(results);
  logResultAnnotations(stats);

  return results;
};
