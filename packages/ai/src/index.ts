// biome-ignore-all lint/performance/noBarrelFile: This is the package entry point

export {
  type AddCacheControlOptions,
  type AnthropicCacheOptions,
  addCacheControl,
  type CacheTTL,
  createCacheableSystemMessage,
  createCachePrepareStep,
  isAnthropicModel,
  type PrepareStepParams,
} from "./cache.js";

export { normalizeModelId } from "./client.js";

export { calculateCost, estimateCost } from "./pricing.js";

export {
  DEFAULT_FAST_MODEL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_SMART_MODEL,
  DEFAULT_TIMEOUT_MS,
  type ModelConfig,
  type TokenUsage,
} from "./types.js";

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
  type ValidationUsage,
  validate,
} from "./validation/index.js";
