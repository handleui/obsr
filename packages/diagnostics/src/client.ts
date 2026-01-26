import { extract } from "./index.js";
import type { Diagnostic, DiagnosticResult } from "./types.js";

export interface ParserOptions {
  /** API key for Detent diagnostics service */
  apiKey?: string;
  /** Custom API URL (default: https://backend.detent.sh/v1/diagnostics) */
  apiUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

const DEFAULT_API_URL = "https://backend.detent.sh/v1/diagnostics";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Allowed URL protocols for API endpoint.
 * HTTP is intentionally excluded to prevent SSRF attacks.
 */
const ALLOWED_PROTOCOLS = ["https:"];

/**
 * Validate that a URL is safe to use as an API endpoint.
 * Prevents SSRF by restricting to HTTPS protocol.
 */
const validateApiUrl = (urlString: string): URL => {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error("Invalid API URL format");
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    throw new Error(
      `Invalid API URL protocol: ${url.protocol}. Only HTTPS is allowed.`
    );
  }

  return url;
};

/**
 * Type guard to validate API response structure.
 */
const isValidApiResponse = (
  data: unknown
): data is {
  detected_tool: string | null;
  diagnostics: Record<string, unknown>[];
  summary: { total: number; errors: number; warnings: number };
} => {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  const obj = data as Record<string, unknown>;

  if (!("detected_tool" in obj)) {
    return false;
  }
  if (obj.detected_tool !== null && typeof obj.detected_tool !== "string") {
    return false;
  }

  if (!("diagnostics" in obj && Array.isArray(obj.diagnostics))) {
    return false;
  }

  if (
    !("summary" in obj) ||
    typeof obj.summary !== "object" ||
    obj.summary === null
  ) {
    return false;
  }

  const summary = obj.summary as Record<string, unknown>;
  if (
    typeof summary.total !== "number" ||
    typeof summary.errors !== "number" ||
    typeof summary.warnings !== "number"
  ) {
    return false;
  }

  return true;
};

/**
 * Map API response diagnostic to internal Diagnostic type with safe type coercion.
 */
const mapApiDiagnostic = (d: Record<string, unknown>): Diagnostic => {
  const suggestions = Array.isArray(d.suggestions)
    ? d.suggestions.filter((s): s is string => typeof s === "string")
    : undefined;

  return {
    message: typeof d.message === "string" ? d.message : "",
    filePath: typeof d.file_path === "string" ? d.file_path : undefined,
    line: typeof d.line === "number" ? d.line : undefined,
    column: typeof d.column === "number" ? d.column : undefined,
    severity:
      d.severity === "error" || d.severity === "warning"
        ? d.severity
        : undefined,
    ruleId: typeof d.rule_id === "string" ? d.rule_id : undefined,
    stackTrace: typeof d.stack_trace === "string" ? d.stack_trace : undefined,
    suggestions: suggestions?.length ? suggestions : undefined,
    fixable: typeof d.fixable === "boolean" ? d.fixable : undefined,
  };
};

/**
 * Create an async parser that tries local parsing first,
 * then falls back to the Detent API if local parsing fails
 * and an API key is configured.
 */
export const createParser = (options?: ParserOptions) => {
  return async (content: string, tool?: string): Promise<DiagnosticResult> => {
    // Try local first
    const result = extract(content, tool);
    if (result.detectedTool) {
      return result;
    }

    // Fallback to API if configured
    if (!options?.apiKey) {
      return result;
    }

    const urlString = options.apiUrl ?? DEFAULT_API_URL;
    const validatedUrl = validateApiUrl(urlString);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetch(validatedUrl.href, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content, tool, mode: "full" }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Diagnostics API error: ${res.status}${text ? ` - ${text.slice(0, 200)}` : ""}`
      );
    }

    const data: unknown = await res.json();

    if (!isValidApiResponse(data)) {
      throw new Error("Invalid API response format");
    }

    return {
      detectedTool: data.detected_tool,
      diagnostics: data.diagnostics.map(mapApiDiagnostic),
      summary: data.summary,
    };
  };
};

export type AsyncParser = ReturnType<typeof createParser>;
