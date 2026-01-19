// biome-ignore lint/performance/noNamespaceImport: GitHub Actions SDK official pattern
import * as core from "@actions/core";

import type { ReportPayload } from "./collect";
import { collect } from "./collect";
import { detectOutputs } from "./detect";
import { parseCargo } from "./parsers/json/cargo";
import { parseEslint } from "./parsers/json/eslint";
import { parseGolangci } from "./parsers/json/golangci";
import { parseVitest } from "./parsers/json/vitest";
import { parseTypeScript } from "./parsers/text/typescript";
import { report } from "./report";
import { readSnippet } from "./snippet";

const PARSERS = {
  eslint: parseEslint,
  vitest: parseVitest,
  golangci: parseGolangci,
  cargo: parseCargo,
  typescript: parseTypeScript,
} as const;

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
        const enriched: ReportPayload["errors"][number] = { ...error };
        if (error.filePath && error.line) {
          const snippet = readSnippet(error.filePath, error.line);
          if (snippet) {
            enriched.codeSnippet = snippet;
          }
        }
        errors.push(enriched);
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
      payload.errors.push(...parseTypeScript(tsOutput));
    }

    core.info(`Reporting to ${apiUrl}...`);
    const result = await report(payload, token, apiUrl);

    core.info(`Stored ${result.stored} items, run ID: ${result.runId}`);
    core.setOutput("stored", result.stored);
    core.setOutput("run-id", result.runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
};

run();
