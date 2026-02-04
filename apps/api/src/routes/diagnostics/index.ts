import { extract } from "@detent/diagnostics";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { scrubSecrets } from "../../lib/scrub-secrets";
import { publicRateLimitMiddleware } from "../../middleware/public-rate-limit";
import type { Env } from "../../types/env";
import {
  DiagnosticsRequestSchema,
  DiagnosticsResponseSchema,
  ErrorResponseSchema,
  RateLimitErrorSchema,
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

**Note:** Sensitive data (API keys, tokens, credentials) detected in the output is automatically redacted for security.`,
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
    429: {
      content: {
        "application/json": {
          schema: RateLimitErrorSchema,
        },
      },
      description: "Rate limit exceeded (30 requests per minute per IP)",
    },
  },
});

const app = new OpenAPIHono<{ Bindings: Env }>();

// Register security schemes for OpenAPI spec
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description:
    "WorkOS access token obtained after login via navigator.detent.sh",
});

app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", {
  type: "apiKey",
  in: "header",
  name: "X-Detent-Token",
  description:
    "Detent API key (dtk_*) for CI/CD and machine-to-machine access. [Get your API key →](https://navigator.detent.sh/settings/api-keys)",
});

// Apply IP-based rate limiting to all routes in this router
app.use("*", publicRateLimitMiddleware);

app.openapi(diagnosticsRoute, async (c) => {
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

  // Run AI validation if requested (limit to first 100 diagnostics to control costs)
  let validation:
    | {
        status: Array<{
          index: number;
          validation: "confirmed" | "false_positive" | "uncertain";
          confidence: "high" | "medium" | "low";
          reason?: string;
        }>;
        missed: Array<{
          message: string;
          file_path?: string;
          line?: number;
          severity?: "error" | "warning";
          missed_reason: string;
        }>;
        summary: {
          total: number;
          confirmed: number;
          false_positives: number;
          uncertain: number;
          missed: number;
        };
      }
    | undefined;

  if (body.validate && result.diagnostics.length > 0) {
    const { validate } = await import("@detent/ai");
    const toValidate = {
      ...result,
      diagnostics: result.diagnostics.slice(0, MAX_VALIDATE_DIAGNOSTICS),
    };
    const validationResult = await validate(body.content, toValidate);

    validation = {
      status: validationResult.validated.map((v, i) => ({
        index: i,
        validation: v.validation,
        confidence: v.confidence,
        reason: v.reason,
      })),
      missed: validationResult.missed.map((m) => ({
        message: m.message,
        file_path: m.filePath,
        line: m.line,
        severity: m.severity,
        missed_reason: m.missedReason,
      })),
      summary: {
        total: validationResult.summary.total,
        confirmed: validationResult.summary.confirmed,
        false_positives: validationResult.summary.falsePositives,
        uncertain: validationResult.summary.uncertain,
        missed: validationResult.summary.missed,
      },
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
