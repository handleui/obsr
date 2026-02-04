// Client
export {
  AIClient,
  createClient,
  type GenerateObjectOptions,
  type GenerateTextOptions,
  normalizeModelId,
  type ObjectResult,
  type TextResult,
} from "./client.js";

// Pricing
export { calculateCost, estimateCost } from "./pricing.js";

// Types
export {
  DEFAULT_FAST_MODEL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_SMART_MODEL,
  DEFAULT_TIMEOUT_MS,
  type ModelConfig,
  type TokenUsage,
} from "./types.js";

// Validation (re-export for convenience)
export {
  type Confidence,
  compactCiOutput,
  createValidator,
  type MissedDiagnostic,
  truncateContent,
  type ValidatedDiagnostic,
  type ValidateOptions,
  type ValidationResult,
  type ValidationStatus,
  validate,
} from "./validation/index.js";
