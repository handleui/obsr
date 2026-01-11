import { isAbsolute } from "node:path";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { runErrors, runs } from "../db/schema";
import { parseService } from "../services/parser";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

// Maximum log size to prevent DoS (10MB)
const MAX_LOG_SIZE = 10 * 1024 * 1024;
const MAX_ZIP_SIZE = 30 * 1024 * 1024;

// Valid log formats
const VALID_FORMATS = ["github-actions", "act", "gitlab", "auto"] as const;
type LogFormat = (typeof VALID_FORMATS)[number];

const VALID_SOURCES = ["github", "gitlab", "auto"] as const;
type LogSource = (typeof VALID_SOURCES)[number];

const VALID_PROVIDERS = ["github", "gitlab"] as const;
type Provider = (typeof VALID_PROVIDERS)[number];

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const isValidFormat = (format: unknown): format is LogFormat => {
  return (
    typeof format === "string" && VALID_FORMATS.includes(format as LogFormat)
  );
};

const isValidSource = (source: unknown): source is LogSource => {
  return (
    typeof source === "string" && VALID_SOURCES.includes(source as LogSource)
  );
};

const isValidProvider = (provider: unknown): provider is Provider => {
  return (
    typeof provider === "string" &&
    VALID_PROVIDERS.includes(provider as Provider)
  );
};

interface ParseRequestBody {
  logs?: string;
  logZipBase64?: string;
  format?: string;
  source?: string;
  runId?: string;
  commitSha?: string;
  repository?: string;
  provider?: string;
  projectId?: string;
  workspacePath?: string;
}

const isZip = (data: Uint8Array): boolean =>
  data.length >= 4 &&
  data[0] === 0x50 &&
  data[1] === 0x4b &&
  (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07);

const decodeBase64 = (value: string): Uint8Array => {
  const normalized = value.replace(/\s/g, "");
  const decoded = atob(normalized);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
};

const decodeZip = (bytes: Uint8Array): string => {
  if (!isZip(bytes)) {
    throw new Error("Invalid zip payload");
  }
  const unzipped = unzipSync(bytes);
  const decoder = new TextDecoder();
  const entries = Object.entries(unzipped).filter(
    ([name]) => name && !name.endsWith("/")
  );
  if (entries.length === 0) {
    throw new Error("Zip archive contained no files");
  }
  const parts: string[] = [];
  let totalBytes = 0;
  for (const [, data] of entries) {
    totalBytes += data.length;
    if (totalBytes > MAX_LOG_SIZE) {
      throw new Error(`logs exceeds maximum size of ${MAX_LOG_SIZE} bytes`);
    }
    parts.push(decoder.decode(data));
  }
  return parts.join("\n");
};

const validateFormat = (format: string | undefined): LogFormat | null => {
  const resolved = format ?? "github-actions";
  return isValidFormat(resolved) ? resolved : null;
};

const validateSource = (source: string | undefined): LogSource | null => {
  const resolved = source ?? "auto";
  return isValidSource(resolved) ? resolved : null;
};

const validateProvider = (provider: string | undefined): Provider | null => {
  if (provider === undefined) {
    return null;
  }
  return isValidProvider(provider) ? provider : null;
};

const validateOptionalString = (
  value: string | undefined,
  maxLength: number
): { value?: string; error?: string } => {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    return { error: "metadata fields must be strings" };
  }
  if (value.length > maxLength) {
    return { error: `metadata exceeds maximum length of ${maxLength} bytes` };
  }
  return { value };
};

const isValidRepository = (repository: string): boolean =>
  REPOSITORY_PATTERN.test(repository);

const validateInlineLogs = (
  logs: unknown
): { logs?: string; error?: string } => {
  if (logs === undefined) {
    return {};
  }
  if (typeof logs !== "string") {
    return { error: "logs must be a string" };
  }
  if (logs.length > MAX_LOG_SIZE) {
    return { error: `logs exceeds maximum size of ${MAX_LOG_SIZE} bytes` };
  }
  if (logs.trim().length === 0) {
    return {};
  }
  return { logs };
};

const decodeZipLogs = (
  logZipBase64: unknown
): { logs?: string; error?: string } => {
  if (logZipBase64 === undefined) {
    return {};
  }
  if (typeof logZipBase64 !== "string") {
    return { error: "logZipBase64 must be a string" };
  }
  if (logZipBase64.length > MAX_ZIP_SIZE * 1.4) {
    return {
      error: `logZipBase64 exceeds maximum size of ${MAX_ZIP_SIZE} bytes`,
    };
  }

  try {
    const zipBytes = decodeBase64(logZipBase64);
    if (zipBytes.byteLength > MAX_ZIP_SIZE) {
      return {
        error: `logZipBase64 exceeds maximum size of ${MAX_ZIP_SIZE} bytes`,
      };
    }
    if (isZip(zipBytes)) {
      return { logs: decodeZip(zipBytes) };
    }
    return { error: "Unsupported compressed log format" };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to decode compressed logs",
    };
  }
};

const resolveLogs = (
  body: ParseRequestBody
): { logs: string } | { error: string } => {
  const inline = validateInlineLogs(body.logs);
  if (inline.error) {
    return { error: inline.error };
  }
  if (inline.logs) {
    return { logs: inline.logs };
  }

  const decoded = decodeZipLogs(body.logZipBase64);
  if (decoded.error) {
    return { error: decoded.error };
  }
  if (decoded.logs) {
    return { logs: decoded.logs };
  }

  return { error: "logs or logZipBase64 is required" };
};

// POST /parse - Parse CI logs and extract errors
app.post("/", async (c) => {
  let body: ParseRequestBody;
  try {
    body = await c.req.json<ParseRequestBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const format = validateFormat(body.format);
  if (!format) {
    return c.json(
      { error: `Invalid format. Must be one of: ${VALID_FORMATS.join(", ")}` },
      400
    );
  }

  const source = validateSource(body.source);
  if (!source) {
    return c.json(
      { error: `Invalid source. Must be one of: ${VALID_SOURCES.join(", ")}` },
      400
    );
  }

  const provider = validateProvider(body.provider);
  if (body.provider !== undefined && !provider) {
    return c.json(
      {
        error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}`,
      },
      400
    );
  }

  const runId = validateOptionalString(body.runId, 255);
  if (runId.error) {
    return c.json({ error: runId.error }, 400);
  }

  const commitSha = validateOptionalString(body.commitSha, 64);
  if (commitSha.error) {
    return c.json({ error: commitSha.error }, 400);
  }

  const repository = validateOptionalString(body.repository, 500);
  if (repository.error) {
    return c.json({ error: repository.error }, 400);
  }
  if (repository.value && !isValidRepository(repository.value)) {
    return c.json({ error: "repository must be in owner/name format" }, 400);
  }

  const projectId = validateOptionalString(body.projectId, 36);
  if (projectId.error) {
    return c.json({ error: projectId.error }, 400);
  }

  const workspacePath = validateOptionalString(body.workspacePath, 2048);
  let resolvedWorkspacePath = workspacePath.value;
  if (workspacePath.error) {
    console.warn("[parse] ignoring invalid workspacePath", workspacePath.error);
    resolvedWorkspacePath = undefined;
  }
  if (resolvedWorkspacePath && !isAbsolute(resolvedWorkspacePath)) {
    console.warn("[parse] workspacePath must be absolute");
    resolvedWorkspacePath = undefined;
  }

  const resolvedLogs = resolveLogs(body);
  if ("error" in resolvedLogs) {
    return c.json({ error: resolvedLogs.error }, 400);
  }

  const result = await parseService.parse({
    logs: resolvedLogs.logs,
    format,
    source,
    runId: runId.value,
    workspacePath: resolvedWorkspacePath,
  });

  const resolvedSource = result.metadata.source;
  const resolvedFormat = result.metadata.format;

  try {
    const { db, client } = await createDb(c.env);
    try {
      const runRecordId = crypto.randomUUID();
      const errorRows = result.errors.map((error) => ({
        id: crypto.randomUUID(),
        runId: runRecordId,
        filePath: error.filePath,
        line: error.line,
        column: error.column,
        message: error.message,
        category: error.category,
        severity: error.severity,
        ruleId: error.ruleId,
        source: error.source,
        stackTrace: error.stackTrace,
        suggestions: error.suggestions ? [...error.suggestions] : undefined,
        hint: error.hint,
        workflowJob: error.workflowJob ?? error.workflowContext?.job,
        workflowStep: error.workflowContext?.step,
        workflowAction: error.workflowContext?.action,
        unknownPattern: error.unknownPattern,
        lineKnown: error.lineKnown,
        columnKnown: error.columnKnown,
        messageTruncated: error.messageTruncated,
        stackTraceTruncated: error.stackTraceTruncated,
        codeSnippet: error.codeSnippet
          ? {
              ...error.codeSnippet,
              lines: [...error.codeSnippet.lines],
            }
          : undefined,
        exitCode: error.exitCode,
        isInfrastructure: error.isInfrastructure,
      }));

      await db.transaction(async (tx) => {
        await tx.insert(runs).values({
          id: runRecordId,
          projectId: projectId.value,
          provider:
            provider ?? (resolvedSource === "unknown" ? null : resolvedSource),
          source: resolvedSource,
          format: resolvedFormat,
          runId: runId.value,
          repository: repository.value,
          commitSha: commitSha.value,
          logBytes: result.metadata.logBytes,
          errorCount: result.metadata.errorCount,
        });

        if (errorRows.length > 0) {
          await tx.insert(runErrors).values(errorRows);
        }
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error("[parse] failed to record parse run", error);
  }

  return c.json(result);
});

export default app;
