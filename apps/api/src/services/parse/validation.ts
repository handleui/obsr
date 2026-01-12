import { isAbsolute, normalize } from "node:path";
import {
  decodeBase64,
  decodeZip,
  isZip,
  MAX_LOG_SIZE,
  MAX_ZIP_SIZE,
} from "./decompression";
import {
  type LogFormat,
  type LogSource,
  type ParseRequest,
  type Provider,
  VALID_FORMATS,
  VALID_PROVIDERS,
  VALID_SOURCES,
  type ValidatedParseRequest,
  ValidationError,
} from "./types";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const isValidFormat = (format: unknown): format is LogFormat =>
  typeof format === "string" && VALID_FORMATS.includes(format as LogFormat);

const isValidSource = (source: unknown): source is LogSource =>
  typeof source === "string" && VALID_SOURCES.includes(source as LogSource);

const isValidProvider = (provider: unknown): provider is Provider =>
  typeof provider === "string" &&
  VALID_PROVIDERS.includes(provider as Provider);

const isValidRepository = (repository: string): boolean =>
  REPOSITORY_PATTERN.test(repository);

const containsPathTraversal = (inputPath: string): boolean => {
  // Check for null bytes
  if (inputPath.includes("\0")) {
    return true;
  }

  // Check for explicit parent directory references
  if (inputPath.includes("..")) {
    return true;
  }

  // Check if normalize changes the path, which may indicate traversal attempts
  // (e.g., repeated slashes, or other path manipulation techniques)
  if (normalize(inputPath) !== inputPath) {
    return true;
  }

  return false;
};

interface StringValidationResult {
  value?: string;
  error?: string;
}

const validateOptionalString = (
  value: string | undefined,
  maxLength: number
): StringValidationResult => {
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

const resolveLogs = (body: ParseRequest): string => {
  const inline = validateInlineLogs(body.logs);
  if (inline.error) {
    throw new ValidationError(inline.error);
  }
  if (inline.logs) {
    return inline.logs;
  }

  const decoded = decodeZipLogs(body.logZipBase64);
  if (decoded.error) {
    throw new ValidationError(decoded.error);
  }
  if (decoded.logs) {
    return decoded.logs;
  }

  throw new ValidationError("logs or logZipBase64 is required");
};

export const validateParseRequest = (
  body: ParseRequest
): ValidatedParseRequest => {
  // Validate format
  const format = body.format ?? "github-actions";
  if (!isValidFormat(format)) {
    throw new ValidationError(
      `Invalid format. Must be one of: ${VALID_FORMATS.join(", ")}`
    );
  }

  // Validate source
  const source = body.source ?? "auto";
  if (!isValidSource(source)) {
    throw new ValidationError(
      `Invalid source. Must be one of: ${VALID_SOURCES.join(", ")}`
    );
  }

  // Validate provider
  let provider: Provider | null = null;
  if (body.provider !== undefined) {
    if (!isValidProvider(body.provider)) {
      throw new ValidationError(
        `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}`
      );
    }
    provider = body.provider;
  }

  // Validate optional string fields
  const runId = validateOptionalString(body.runId, 255);
  if (runId.error) {
    throw new ValidationError(runId.error);
  }

  const commitSha = validateOptionalString(body.commitSha, 64);
  if (commitSha.error) {
    throw new ValidationError(commitSha.error);
  }

  const repository = validateOptionalString(body.repository, 500);
  if (repository.error) {
    throw new ValidationError(repository.error);
  }
  if (repository.value && !isValidRepository(repository.value)) {
    throw new ValidationError("repository must be in owner/name format");
  }

  const projectId = validateOptionalString(body.projectId, 36);
  if (projectId.error) {
    throw new ValidationError(projectId.error);
  }

  // Validate workspacePath (warn but don't fail)
  let workspacePath: string | undefined;
  const workspacePathResult = validateOptionalString(body.workspacePath, 2048);
  if (workspacePathResult.error) {
    console.warn(
      "[parse] ignoring invalid workspacePath",
      workspacePathResult.error
    );
  } else if (
    workspacePathResult.value &&
    !isAbsolute(workspacePathResult.value)
  ) {
    console.warn("[parse] workspacePath must be absolute");
  } else if (
    workspacePathResult.value &&
    containsPathTraversal(workspacePathResult.value)
  ) {
    console.warn("[parse] workspacePath contains invalid characters");
  } else {
    workspacePath = workspacePathResult.value;
  }

  // Resolve logs (inline or decompress zip)
  const logs = resolveLogs(body);

  return {
    logs,
    format,
    source,
    provider,
    runId: runId.value,
    commitSha: commitSha.value,
    repository: repository.value,
    projectId: projectId.value,
    workspacePath,
  };
};
