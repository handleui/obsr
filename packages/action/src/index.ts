// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as core from "@actions/core";
import type { Diagnostic } from "@detent/diagnostics";
import {
  parseCargo,
  parseEslint,
  parseGolangci,
  parseTypeScript,
  parseVitest,
} from "@detent/diagnostics";
import type { AutofixResult } from "./autofix/executor";
import { runAutofix } from "./autofix/executor";
import { getAutofixesForSources } from "./autofix/registry";
import type { ReportPayload } from "./collect";
import { collect } from "./collect";
import { detectOutputs } from "./detect";
import type { ClassifiedReportError } from "./errors";
import { classifyReportError } from "./errors";

import { ReportApiError, report, reportAutofixResults } from "./report";

import { readSnippet } from "./snippet";

/**
 * Write a job summary with troubleshooting information.
 */
const writeTroubleshootingSummary = async (
  classified: ClassifiedReportError
): Promise<void> => {
  const links = [
    "[Documentation](https://detent.sh/docs/action)",
    "[Status Page](https://status.detent.sh)",
  ];
  if (classified.docsUrl) {
    links.push(`[Specific Guide](${classified.docsUrl})`);
  }

  await core.summary
    .addHeading("Detent Report Failed", 2)
    .addRaw(`**Error:** ${classified.title}`)
    .addBreak()
    .addRaw(classified.message)
    .addHeading("Suggested Fixes", 3)
    .addList(classified.suggestions)
    .addHeading("Need Help?", 3)
    .addList(links)
    .write();
};

const PARSERS = {
  eslint: parseEslint,
  vitest: parseVitest,
  golangci: parseGolangci,
  cargo: parseCargo,
  typescript: parseTypeScript,
} as const;

// SSRF protection regex patterns (top-level for performance)
const IPV6_MAPPED_IPV4_PATTERN =
  /^(?:\[)?::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\])?$/;
const OCTAL_IP_PATTERN =
  /^0\d+\.\d+\.\d+\.\d+$|^\d+\.0\d+\.\d+\.\d+$|^\d+\.\d+\.0\d+\.\d+$|^\d+\.\d+\.\d+\.0\d+$/;

/**
 * Enrich a diagnostic with a code snippet from the source file.
 */
const enrichWithSnippet = (
  diagnostic: Diagnostic
): ReportPayload["errors"][number] => {
  const enriched: ReportPayload["errors"][number] = { ...diagnostic };
  if (diagnostic.filePath && diagnostic.line) {
    const snippet = readSnippet(diagnostic.filePath, diagnostic.line);
    if (snippet) {
      enriched.codeSnippet = snippet;
    }
  }
  return enriched;
};

/**
 * Parse detected outputs and enrich errors with code snippets.
 * Continues processing even if individual parsers fail.
 */
const parseAndEnrichErrors = (
  outputs: ReturnType<typeof detectOutputs>
): ReportPayload["errors"] => {
  const errors: ReportPayload["errors"] = [];

  for (const { tool, content, path } of outputs) {
    const parser = PARSERS[tool as keyof typeof PARSERS];
    if (!parser) {
      core.debug(`No parser found for tool: ${tool}`);
      continue;
    }

    try {
      const parsed = parser(content);
      for (const error of parsed) {
        errors.push(enrichWithSnippet(error));
      }
      core.debug(`Parsed ${parsed.length} errors from ${tool} (${path})`);
    } catch (err) {
      core.warning(
        `Failed to parse ${tool} output from ${path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return errors;
};

/**
 * Check if hostname is a private/internal IP address
 * Provides comprehensive SSRF protection
 *
 * NOTE: DNS rebinding attacks cannot be fully prevented at hostname level.
 * For production systems, resolve the hostname to IP and check the resolved
 * IP address before making the request. Consider using a DNS resolver that
 * returns all IPs and checking each one.
 */
const isPrivateHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase();

  // IPv4 loopback and special addresses
  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0") {
    return true;
  }

  // IPv6 loopback
  if (h === "::1" || h === "[::1]") {
    return true;
  }

  // IPv4-mapped IPv6 addresses (::ffff:127.0.0.1, ::ffff:192.168.1.1, etc.)
  // These embed IPv4 addresses in IPv6 format and can bypass naive checks
  const ipv6MappedMatch = h.match(IPV6_MAPPED_IPV4_PATTERN);
  if (ipv6MappedMatch) {
    // Recursively check the embedded IPv4 address
    return isPrivateHost(ipv6MappedMatch[1]);
  }

  // Octal notation detection (e.g., 0177.0.0.1 = 127.0.0.1)
  // IPs with leading zeros in any octet are treated as octal by some parsers
  if (OCTAL_IP_PATTERN.test(h)) {
    return true;
  }

  // Hex notation detection (e.g., 0x7f.0.0.1 = 127.0.0.1, 0x7f000001)
  // Block any IP containing hex notation
  if (h.includes("0x")) {
    return true;
  }

  // IPv4 private ranges
  if (
    h.startsWith("192.168.") ||
    h.startsWith("10.") ||
    h.startsWith("172.16.") ||
    h.startsWith("172.17.") ||
    h.startsWith("172.18.") ||
    h.startsWith("172.19.") ||
    h.startsWith("172.20.") ||
    h.startsWith("172.21.") ||
    h.startsWith("172.22.") ||
    h.startsWith("172.23.") ||
    h.startsWith("172.24.") ||
    h.startsWith("172.25.") ||
    h.startsWith("172.26.") ||
    h.startsWith("172.27.") ||
    h.startsWith("172.28.") ||
    h.startsWith("172.29.") ||
    h.startsWith("172.30.") ||
    h.startsWith("172.31.")
  ) {
    return true;
  }

  // IPv4 link-local (169.254.x.x)
  if (h.startsWith("169.254.")) {
    return true;
  }

  // IPv6 private (fc00::/7 - includes fc00:: and fd00::)
  // IPv6 link-local (fe80::/10)
  // Handle both bracketed and non-bracketed forms
  const ipv6 = h.startsWith("[") ? h.slice(1, -1) : h;
  if (
    ipv6.startsWith("fc") ||
    ipv6.startsWith("fd") ||
    ipv6.startsWith("fe80")
  ) {
    return true;
  }

  return false;
};

/**
 * Validate that the API URL is a valid HTTPS URL
 * Prevents SSRF and ensures secure communication
 */
const validateApiUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    // Only allow HTTPS in production (HTTP allowed for local development)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    // Block localhost/internal IPs in production (SSRF protection)
    // Allow localhost for development (HTTP only)
    if (parsed.protocol === "https:" && isPrivateHost(parsed.hostname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

/**
 * Extract PR number from GitHub context.
 * Returns the PR number if running in a pull_request event, otherwise undefined.
 */
const getPrNumber = (): number | undefined => {
  const { context } = require("@actions/github");
  // PR number is available in pull_request event payload
  if (context.payload.pull_request?.number) {
    return context.payload.pull_request.number;
  }
  // Also check issue_comment events (for PR comments)
  if (context.payload.issue?.pull_request && context.payload.issue?.number) {
    return context.payload.issue.number;
  }
  return undefined;
};

/**
 * Run autofixes for detected errors and report results to API.
 * Only runs fixes for errors from sources with autofix support.
 */
const runAutofixes = async (
  payload: ReportPayload,
  projectId: string,
  runId: string,
  prNumber: number | undefined,
  token: string,
  apiUrl: string
): Promise<void> => {
  // Autofix requires a PR context to push changes
  if (!prNumber) {
    core.debug("Skipping autofix: not running in a pull request context");
    return;
  }

  // Get unique sources from errors that have category (tool source)
  const sources = payload.errors
    .map((e) => e.category)
    .filter((c): c is string => c !== undefined);

  // Get autofix configs for sources with autofix support, sorted by priority
  const autofixConfigs = getAutofixesForSources(sources);

  if (autofixConfigs.length === 0) {
    core.debug("No autofixes available for detected errors");
    return;
  }

  core.info(`Running ${autofixConfigs.length} autofix(es)...`);

  const results: AutofixResult[] = [];

  for (const config of autofixConfigs) {
    try {
      const result = runAutofix(config.source);
      results.push(result);
    } catch (err) {
      core.warning(
        `Autofix for ${config.source} failed: ${err instanceof Error ? err.message : String(err)}`
      );
      results.push({
        source: config.source,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Report results if any fixes were attempted
  if (results.length > 0) {
    try {
      const autofixResult = await reportAutofixResults(
        projectId,
        runId,
        prNumber,
        results,
        token,
        apiUrl
      );
      core.info(`Reported ${autofixResult.received} autofix result(s)`);
    } catch (err) {
      core.warning(
        `Failed to report autofix results: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
};

const run = async (): Promise<void> => {
  try {
    const token = core.getInput("token", { required: true });
    const apiUrl = core.getInput("api-url") || "https://backend.detent.sh";

    // Mark token as secret to prevent accidental logging
    core.setSecret(token);

    // Validate API URL to prevent SSRF
    if (!validateApiUrl(apiUrl)) {
      throw new Error(
        "Invalid api-url: must be a valid HTTPS URL (HTTP allowed for localhost only)"
      );
    }

    core.info("Collecting workflow context...");
    const payload = collect();

    // Detect and parse JSON output files
    const outputs = detectOutputs();
    payload.errors.push(...parseAndEnrichErrors(outputs));

    // Check for TypeScript output in env
    const tsOutput = process.env.TYPESCRIPT_OUTPUT;
    if (tsOutput) {
      const tsErrors = parseTypeScript(tsOutput).map(enrichWithSnippet);
      payload.errors.push(...tsErrors);
    }

    core.info(`Reporting to ${apiUrl}...`);
    const result = await report(payload, token, apiUrl);

    core.info(`Stored ${result.stored} items, run ID: ${result.runId}`);
    core.setOutput("stored", result.stored);
    core.setOutput("run-id", result.runId);
    core.setOutput("project-id", result.projectId);

    // Run autofixes for fixable errors (only in PR context)
    const prNumber = getPrNumber();
    await runAutofixes(
      payload,
      result.projectId,
      result.runId,
      prNumber,
      token,
      apiUrl
    );
  } catch (error) {
    // Classify the error and provide actionable guidance
    const statusCode =
      error instanceof ReportApiError ? error.statusCode : undefined;
    const responseBody =
      error instanceof ReportApiError ? error.responseBody : undefined;

    const classified = classifyReportError(error, statusCode, responseBody);

    // Primary error annotation (visible in PR checks UI)
    core.error(classified.message, { title: classified.title });

    // Suggestions as warnings (visible but non-blocking)
    for (const suggestion of classified.suggestions) {
      core.warning(suggestion);
    }

    // Write job summary with detailed troubleshooting
    await writeTroubleshootingSummary(classified);

    // Set failed with concise title
    core.setFailed(classified.title);
  }
};

run();
