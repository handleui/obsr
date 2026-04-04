import { DEFAULT_FAST_MODEL, DEFAULT_SMART_MODEL } from "./model-defaults.js";

// Minimal shape for routing — decoupled from resolver's RunErrorRow
// Domain routing for model selection stays out of @obsr/issues; keep this file transport-only.
interface RoutableError {
  category: string | null;
  stackTrace: string | null;
}

const FAST_CATEGORIES = new Set(["lint", "type-check", "docs", "metadata"]);

const classifyError = (error: RoutableError): "fast" | "smart" => {
  if (error.stackTrace) {
    return "smart";
  }
  if (error.category && FAST_CATEGORIES.has(error.category)) {
    return "fast";
  }
  return "smart";
};

export const selectModelForErrors = (errors: RoutableError[]): string => {
  if (errors.length === 0) {
    return DEFAULT_SMART_MODEL;
  }
  const allFast = errors.every((e) => classifyError(e) === "fast");
  return allFast ? DEFAULT_FAST_MODEL : DEFAULT_SMART_MODEL;
};
