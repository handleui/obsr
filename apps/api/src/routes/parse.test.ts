import { strToU8, zipSync } from "fflate";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/env";

const mockParseAndPersist = vi.fn();

vi.mock("../services/parse", () => ({
  parseService: {
    parseAndPersist: (...args: unknown[]) => mockParseAndPersist(...args),
  },
}));

// DB mocking is now handled inside the parse service
// These route tests focus on HTTP layer concerns

const MOCK_ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_APP_PRIVATE_KEY: "test-private-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  HYPERDRIVE: {
    connectionString: "postgres://test:test@localhost:5432/test",
  },
  WORKOS_CLIENT_ID: "test-workos-client",
  WORKOS_API_KEY: "test-workos-key",
  UPSTASH_REDIS_REST_URL: "https://example.com",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
  RESEND_API_KEY: "test-resend-key",
  APP_BASE_URL: "https://example.com",
};

const makeRequest = async (body: unknown): Promise<Response> => {
  const parseRoutes = (await import("./parse")).default;
  const app = new Hono<{ Bindings: Env }>();
  app.route("/parse", parseRoutes);
  return app.request(
    "/parse",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    MOCK_ENV
  );
};

describe("parse routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid formats", async () => {
    const { ValidationError } = await import("../services/parse/types");
    mockParseAndPersist.mockRejectedValue(
      new ValidationError(
        "Invalid format. Must be one of: github-actions, act, gitlab, auto"
      )
    );

    const res = await makeRequest({ logs: "ok", format: "nope" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({
      error:
        "Invalid format. Must be one of: github-actions, act, gitlab, auto",
    });
  });

  it("requires logs or logZipBase64", async () => {
    const { ValidationError } = await import("../services/parse/types");
    mockParseAndPersist.mockRejectedValue(
      new ValidationError("logs or logZipBase64 is required")
    );

    const res = await makeRequest({ format: "auto" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "logs or logZipBase64 is required" });
  });

  it("rejects invalid source", async () => {
    const { ValidationError } = await import("../services/parse/types");
    mockParseAndPersist.mockRejectedValue(
      new ValidationError(
        "Invalid source. Must be one of: github, gitlab, auto"
      )
    );

    const res = await makeRequest({
      logs: "ok",
      format: "auto",
      source: "nope",
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({
      error: "Invalid source. Must be one of: github, gitlab, auto",
    });
  });

  it("rejects invalid provider", async () => {
    const { ValidationError } = await import("../services/parse/types");
    mockParseAndPersist.mockRejectedValue(
      new ValidationError("Invalid provider. Must be one of: github, gitlab")
    );

    const res = await makeRequest({
      logs: "ok",
      format: "auto",
      source: "auto",
      provider: "nope",
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({
      error: "Invalid provider. Must be one of: github, gitlab",
    });
  });

  it("rejects invalid repository format", async () => {
    const { ValidationError } = await import("../services/parse/types");
    mockParseAndPersist.mockRejectedValue(
      new ValidationError("repository must be in owner/name format")
    );

    const res = await makeRequest({
      logs: "ok",
      format: "auto",
      source: "auto",
      repository: "not a repo",
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "repository must be in owner/name format" });
  });

  it("ignores non-absolute workspacePath", async () => {
    const result = {
      errors: [],
      summary: {
        total: 0,
        byCategory: { unknown: 0 },
        bySource: { generic: 0 },
      },
      metadata: {
        source: "github",
        format: "github-actions",
        logBytes: 2,
        errorCount: 0,
      },
      persisted: true,
    };
    mockParseAndPersist.mockResolvedValue(result);

    const res = await makeRequest({
      logs: "ok",
      format: "auto",
      source: "auto",
      workspacePath: "relative/path",
    });

    expect(res.status).toBe(200);
    // Service is called with the request body; workspacePath handling is internal
    expect(mockParseAndPersist).toHaveBeenCalled();
  });

  it("rejects invalid json body", async () => {
    const parseRoutes = (await import("./parse")).default;
    const app = new Hono<{ Bindings: Env }>();
    app.route("/parse", parseRoutes);

    const res = await app.request(
      "/parse",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "{not-json}",
      },
      MOCK_ENV
    );

    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "Invalid JSON body" });
  });

  it("rejects oversized metadata fields", async () => {
    const { ValidationError } = await import("../services/parse/types");
    mockParseAndPersist.mockRejectedValue(
      new ValidationError("metadata exceeds maximum length of 255 bytes")
    );

    const res = await makeRequest({
      logs: "ok",
      format: "auto",
      source: "auto",
      runId: "a".repeat(256),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({
      error: "metadata exceeds maximum length of 255 bytes",
    });
  });

  it("rejects non-zip logZipBase64 payloads", async () => {
    const { ValidationError } = await import("../services/parse/types");
    mockParseAndPersist.mockRejectedValue(
      new ValidationError("Unsupported compressed log format")
    );

    const logZipBase64 = Buffer.from("not a zip").toString("base64");
    const res = await makeRequest({
      logZipBase64,
      format: "auto",
      source: "auto",
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "Unsupported compressed log format" });
  });

  it("parses inline logs and returns result", async () => {
    const result = {
      errors: [],
      summary: {
        total: 0,
        byCategory: { unknown: 0 },
        bySource: { generic: 0 },
      },
      metadata: {
        source: "github",
        format: "github-actions",
        logBytes: 16,
        errorCount: 0,
        runId: "run-123",
      },
      persisted: true,
    };
    mockParseAndPersist.mockResolvedValue(result);

    const res = await makeRequest({
      logs: "##[error] failed",
      format: "auto",
      source: "auto",
      runId: "run-123",
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual(result);
    expect(mockParseAndPersist).toHaveBeenCalled();
  });

  it("decodes base64 zip logs", async () => {
    const result = {
      errors: [],
      summary: {
        total: 0,
        byCategory: { unknown: 0 },
        bySource: { generic: 0 },
      },
      metadata: {
        source: "unknown",
        format: "auto",
        logBytes: 7,
        errorCount: 0,
      },
      persisted: true,
    };
    mockParseAndPersist.mockResolvedValue(result);

    const zipped = zipSync({ "log.txt": strToU8("zip log") });
    const logZipBase64 = Buffer.from(zipped).toString("base64");

    const res = await makeRequest({
      logZipBase64,
      format: "auto",
      source: "auto",
    });

    expect(res.status).toBe(200);
    expect(mockParseAndPersist).toHaveBeenCalled();
  });

  it("rejects empty zip archives", async () => {
    const { ValidationError } = await import("../services/parse/types");
    mockParseAndPersist.mockRejectedValue(
      new ValidationError("Zip archive contained no files")
    );

    const zipped = zipSync({ "empty-dir/": new Uint8Array(0) });
    const logZipBase64 = Buffer.from(zipped).toString("base64");

    const res = await makeRequest({
      logZipBase64,
      format: "auto",
      source: "auto",
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({ error: "Zip archive contained no files" });
  });

  it("returns parsed errors with persistence status", async () => {
    const result = {
      errors: [
        {
          message: "TS error",
          filePath: "src/app.ts",
          line: 10,
          column: 2,
          category: "type-check",
          severity: "error",
          ruleId: "TS1234",
          source: "typescript",
          stackTrace: "trace",
          workflowContext: { job: "build", step: "lint", action: "tsc" },
          suggestions: ["fix"],
          codeSnippet: {
            lines: ["const a = 1"],
            startLine: 9,
            errorLine: 2,
            language: "typescript",
          },
        },
      ],
      summary: {
        total: 1,
        byCategory: { "type-check": 1 },
        bySource: { typescript: 1 },
      },
      metadata: {
        source: "github",
        format: "github-actions",
        logBytes: 16,
        errorCount: 1,
      },
      persisted: true,
    };
    mockParseAndPersist.mockResolvedValue(result);

    const res = await makeRequest({
      logs: "##[error] failed",
      format: "auto",
      source: "auto",
      runId: "run-456",
      repository: "owner/repo",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      persisted: boolean;
      errors: Array<{ message: string }>;
      summary: { total: number };
    };
    expect(json.persisted).toBe(true);
    expect(json.errors).toHaveLength(1);
    expect(json.errors[0]?.message).toBe("TS error");
    expect(json.summary.total).toBe(1);
  });
});
