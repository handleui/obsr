import { validate } from "@detent/ai";
import { extract } from "@detent/diagnostics";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { scrubSecrets } from "../../lib/scrub-secrets";
import { apiKeyAuthMiddleware } from "../../middleware/api-key-auth";
import { apiKeyRateLimitMiddleware } from "../../middleware/api-key-rate-limit";
import type { Env } from "../../types/env";
import {
  DiagnosticsRequestSchema,
  DiagnosticsResponseSchema,
  ErrorResponseSchema,
  RateLimitErrorSchema,
  type ValidationResult,
} from "./schemas";

const MAX_DIAGNOSTICS = 10_000;
const MAX_VALIDATE_DIAGNOSTICS = 100;

const diagnosticsRoute = createRoute({
  method: "post",
  path: "/v1/diagnostics",
  tags: ["Diagnostics"],
  summary: "Parse CI/build logs into structured diagnostics",
  description: `Extracts structured error and warning information from raw CI/build log output.

Supports auto-detection of common tools (ESLint, TypeScript, Vitest, Cargo, golangci-lint) or accepts a hint via the \`tool\` parameter.

Returns parsed diagnostics with file locations, severity, and tool-specific metadata.

**Note:** Sensitive data (API keys, tokens, credentials) detected in the output is automatically redacted for security.

AI validation is automatically enabled when the organization has \`validationEnabled\` set in their settings.`,
  security: [{ apiKey: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: DiagnosticsRequestSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: DiagnosticsResponseSchema,
        },
      },
      description: "Successfully parsed diagnostics",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Invalid request body",
    },
    401: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Authentication required",
    },
    429: {
      content: {
        "application/json": {
          schema: RateLimitErrorSchema,
        },
      },
      description: "Rate limit exceeded",
    },
  },
});

const app = new OpenAPIHono<{ Bindings: Env }>();

// Register security scheme for OpenAPI spec
app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "X-Detent-Token",
  description:
    "Detent API key (dtk_*) for CI/CD and machine-to-machine access. [Get your API key →](https://navigator.detent.sh/settings/api-keys)",
});

// Apply API key authentication and rate limiting
app.use("*", apiKeyAuthMiddleware);
app.use("*", apiKeyRateLimitMiddleware);

app.openapi(diagnosticsRoute, async (c) => {
  const { orgSettings } = c.get("apiKeyAuth");
  const body = c.req.valid("json");

  // Zod validates tool against DetectedToolSchema; type assertion aligns with extract() signature
  const result = extract(body.content, body.tool);

  const truncated = result.diagnostics.length > MAX_DIAGNOSTICS;
  const limitedDiagnostics = truncated
    ? result.diagnostics.slice(0, MAX_DIAGNOSTICS)
    : result.diagnostics;

  if (body.mode === "lite") {
    return c.json(
      {
        mode: "lite" as const,
        detected_tool: result.detectedTool,
        diagnostics: limitedDiagnostics.map((d) => ({
          message: scrubSecrets(d.message),
          file_path: d.filePath,
          line: d.line,
          column: d.column,
        })),
        truncated,
      },
      200
    );
  }

  // Run AI validation if org has it enabled (limit to first 100 diagnostics to control costs)
  // Sync validation is intentional: the validation result is part of the response body,
  // and orgs opt in knowing there's LLM latency. Background processing would require
  // polling/webhooks, adding complexity without clear benefit for this use case.
  let validation: ValidationResult | undefined;

  if (orgSettings.validationEnabled && result.diagnostics.length > 0) {
    const toValidate = {
      ...result,
      diagnostics: result.diagnostics.slice(0, MAX_VALIDATE_DIAGNOSTICS),
    };
    const validationResult = await validate(body.content, toValidate);

    validation = {
      status: validationResult.validated.map((v, i) => ({
        index: i + 1, // 1-based to match AI validation schema
        validation: v.validation,
        confidence: v.confidence,
        reason: v.reason ? scrubSecrets(v.reason) : undefined,
      })),
      // Scrub AI-generated content to prevent secret leakage from CI output
      missed: validationResult.missed.map((m) => ({
        message: scrubSecrets(m.message),
        file_path: m.filePath,
        line: m.line,
        severity: m.severity,
        missed_reason: scrubSecrets(m.missedReason),
      })),
      summary: {
        total: validationResult.summary.total,
        confirmed: validationResult.summary.confirmed,
        false_positives: validationResult.summary.falsePositives,
        uncertain: validationResult.summary.uncertain,
        missed: validationResult.summary.missed,
      },
      cost_usd: validationResult.costUsd,
    };
  }

  return c.json(
    {
      mode: "full" as const,
      detected_tool: result.detectedTool,
      diagnostics: limitedDiagnostics.map((d) => ({
        message: scrubSecrets(d.message),
        file_path: d.filePath,
        line: d.line,
        column: d.column,
        severity: d.severity ?? "error",
        rule_id: d.ruleId,
        stack_trace: d.stackTrace ? scrubSecrets(d.stackTrace) : undefined,
        hints: d.hints?.map(scrubSecrets),
        fixable: d.fixable,
      })),
      summary: result.summary,
      truncated,
      validation,
    },
    200
  );
});

export default app;
