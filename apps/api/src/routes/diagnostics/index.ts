import { extractErrors } from "@detent/extract";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { scrubFilePath, scrubSecrets } from "../../lib/scrub-secrets";
import { apiKeyAuthMiddleware } from "../../middleware/api-key-auth";
import { apiKeyRateLimitMiddleware } from "../../middleware/api-key-rate-limit";
import type { Env } from "../../types/env";
import {
  DiagnosticsRequestSchema,
  DiagnosticsResponseSchema,
  ErrorResponseSchema,
  RateLimitErrorSchema,
} from "./schemas";

const MAX_DIAGNOSTICS = 10_000;

/** Scrub sensitive data from diagnostic before returning in API response */
const scrubDiagnosticResponse = (d: {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  severity?: "error" | "warning";
  ruleId?: string;
  stackTrace?: string;
  hints?: string[];
  fixable?: boolean;
}) => ({
  message: scrubSecrets(d.message),
  file_path: scrubFilePath(d.filePath),
  line: d.line,
  column: d.column,
  severity: d.severity ?? "error",
  rule_id: d.ruleId,
  stack_trace: d.stackTrace ? scrubSecrets(d.stackTrace) : undefined,
  hints: d.hints?.map(scrubSecrets),
  fixable: d.fixable,
});

const diagnosticsRoute = createRoute({
  method: "post",
  path: "/v1/diagnostics",
  tags: ["Diagnostics"],
  summary: "Parse CI/build logs into structured diagnostics",
  description: `Extracts structured error and warning information from raw CI/build log output using AI.

Auto-detects tool format (ESLint, TypeScript, Vitest, Cargo, golangci-lint, etc.) from the output.

Returns parsed diagnostics with file locations, severity, and tool-specific metadata.

**Note:** Sensitive data (API keys, tokens, credentials) detected in the output is automatically redacted for security.`,
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
    503: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "AI extraction service unavailable",
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
  const body = c.req.valid("json");
  const correlationId = crypto.randomUUID();

  // AI extraction - no separate validation needed
  let result: Awaited<ReturnType<typeof extractErrors>>;
  try {
    result = await extractErrors(body.content, {
      apiKey: c.env.AI_GATEWAY_API_KEY,
    });
  } catch (err) {
    const apiKeyAuth = c.get("apiKeyAuth");
    console.error("AI extraction failed:", {
      correlationId,
      organizationId: apiKeyAuth.organizationId,
      requestId: c.req.header("CF-Ray"),
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    });
    return c.json(
      {
        error: "AI extraction service temporarily unavailable",
        correlation_id: correlationId,
      },
      503
    );
  }

  const truncated = result.errors.length > MAX_DIAGNOSTICS;
  const limitedErrors = truncated
    ? result.errors.slice(0, MAX_DIAGNOSTICS)
    : result.errors;

  if (body.mode === "lite") {
    return c.json(
      {
        mode: "lite" as const,
        detected_tool: result.detectedSource,
        diagnostics: limitedErrors.map((d) => ({
          message: scrubSecrets(d.message),
          file_path: scrubFilePath(d.filePath),
          line: d.line,
          column: d.column,
        })),
        truncated,
      },
      200
    );
  }

  // Compute summary only for full mode
  const summary = {
    total: limitedErrors.length,
    errors: limitedErrors.filter((e) => e.severity === "error").length,
    warnings: limitedErrors.filter((e) => e.severity === "warning").length,
  };

  // Use scrubDiagnosticResponse to sanitize all fields before returning
  return c.json(
    {
      mode: "full" as const,
      detected_tool: result.detectedSource,
      diagnostics: limitedErrors.map(scrubDiagnosticResponse),
      summary,
      truncated,
      // Include extraction cost in response
      extraction_cost_usd: result.costUsd,
    },
    200
  );
});

export default app;
