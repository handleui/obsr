import {
  DETECTED_TOOLS,
  type DetectedTool,
  type Diagnostic,
  extract,
  type Severity,
} from "@detent/diagnostics";
import { Hono } from "hono";
import type { Env } from "../types/env";

interface DiagnosticResponse {
  message: string;
  file_path?: string;
  line?: number;
  column?: number;
  severity: Severity;
  rule_id?: string;
  stack_trace?: string;
  suggestions?: string[];
  fixable?: boolean;
}

// Lite mode intentionally excludes severity/ruleId/etc for smaller payloads
interface DiagnosticLite {
  message: string;
  file_path?: string;
  line?: number;
  column?: number;
}

interface DiagnosticsResponseFull {
  detected_tool: DetectedTool | null;
  diagnostics: DiagnosticResponse[];
  summary: {
    total: number;
    errors: number;
    warnings: number;
  };
  truncated: boolean;
}

interface DiagnosticsResponseLite {
  detected_tool: DetectedTool | null;
  diagnostics: DiagnosticLite[];
  truncated: boolean;
}

const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
/**
 * Maximum diagnostics returned to prevent memory exhaustion.
 * Typical CI runs have <1000 errors; 10k is generous for edge cases.
 */
const MAX_DIAGNOSTICS = 10_000;

const VALID_TOOLS = DETECTED_TOOLS;

const isValidTool = (tool: unknown): tool is DetectedTool =>
  typeof tool === "string" && VALID_TOOLS.includes(tool as DetectedTool);

const toResponse = (diagnostic: Diagnostic): DiagnosticResponse => ({
  message: diagnostic.message,
  file_path: diagnostic.filePath,
  line: diagnostic.line,
  column: diagnostic.column,
  severity: diagnostic.severity ?? "error",
  rule_id: diagnostic.ruleId,
  stack_trace: diagnostic.stackTrace,
  suggestions: diagnostic.suggestions,
  fixable: diagnostic.fixable,
});

const toLiteDiagnostic = (diagnostic: Diagnostic): DiagnosticLite => ({
  message: diagnostic.message,
  file_path: diagnostic.filePath,
  line: diagnostic.line,
  column: diagnostic.column,
});

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Request body must be an object" }, 400);
  }

  const req = body as Record<string, unknown>;

  if (typeof req.content !== "string") {
    return c.json({ error: "content must be a string" }, 400);
  }

  if (req.content.length === 0) {
    return c.json({ error: "content must not be empty" }, 400);
  }

  if (req.content.length > MAX_CONTENT_LENGTH) {
    return c.json({ error: "content exceeds maximum length of 10MB" }, 400);
  }

  const tool = req.tool;
  if (tool !== undefined && !isValidTool(tool)) {
    return c.json(
      { error: `tool must be one of: ${VALID_TOOLS.join(", ")}` },
      400
    );
  }

  const mode = req.mode ?? "full";
  if (mode !== "full" && mode !== "lite") {
    return c.json({ error: "mode must be 'full' or 'lite'" }, 400);
  }

  const result = extract(req.content, tool as DetectedTool | undefined);

  // Limit diagnostics to prevent memory exhaustion
  const truncated = result.diagnostics.length > MAX_DIAGNOSTICS;
  const limitedDiagnostics = truncated
    ? result.diagnostics.slice(0, MAX_DIAGNOSTICS)
    : result.diagnostics;

  if (mode === "lite") {
    const response: DiagnosticsResponseLite = {
      detected_tool: result.detectedTool,
      diagnostics: limitedDiagnostics.map(toLiteDiagnostic),
      truncated,
    };
    return c.json(response);
  }

  const response: DiagnosticsResponseFull = {
    detected_tool: result.detectedTool,
    diagnostics: limitedDiagnostics.map(toResponse),
    summary: result.summary,
    truncated,
  };

  return c.json(response);
});

export default app;
