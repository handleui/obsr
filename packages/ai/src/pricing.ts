import type { TokenUsage } from "./types.js";

/**
 * Model pricing in USD per million tokens.
 * Cache pricing: read = 0.1x base input, write (5-min TTL) = 1.25x base input
 */
interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Model prefixes mapped to their pricing.
 * Order matters: more specific prefixes should come before less specific ones.
 *
 * Official pricing pages:
 * - Anthropic: https://www.anthropic.com/pricing
 * - OpenAI: https://openai.com/api/pricing
 * Last verified: 2025-02 (check these pages periodically)
 */
const MODEL_PREFIXES: Array<{ prefix: string; pricing: ModelPricing }> = [
  {
    prefix: "gpt-5.2-codex",
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14.0 },
  },
  // GPT-4o models
  {
    prefix: "gpt-4o-mini",
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  },
  {
    prefix: "gpt-4o",
    pricing: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  },
  // Claude 4.5 models
  {
    prefix: "claude-opus-4-5",
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  },
  {
    prefix: "claude-sonnet-4-5",
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  },
  {
    prefix: "claude-haiku-4-5",
    pricing: { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  },
  // Claude 4.1 models
  {
    prefix: "claude-opus-4-1",
    pricing: { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  },
  // Claude 4 models
  {
    prefix: "claude-opus-4",
    pricing: { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  },
  {
    prefix: "claude-sonnet-4",
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  },
  // Claude 3.x models
  {
    prefix: "claude-3-7-sonnet",
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  },
  {
    prefix: "claude-3-5-sonnet",
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  },
  {
    prefix: "claude-3-5-haiku",
    pricing: { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  },
  {
    prefix: "claude-3-opus",
    pricing: { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  },
  {
    prefix: "claude-3-haiku",
    pricing: { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  },
];

/**
 * Default pricing used for unknown models (sonnet pricing as fallback).
 */
const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
};

/**
 * Normalizes model IDs by stripping provider prefixes like "openai/".
 */
const normalizeModelName = (model: string): string => {
  const parts = model.split("/");
  if (parts.length <= 1) {
    return model;
  }
  return parts.at(-1) ?? model;
};

/**
 * Gets the pricing for a model using prefix matching.
 */
const getPricing = (model: string): ModelPricing => {
  const normalized = normalizeModelName(model);
  for (const { prefix, pricing } of MODEL_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return pricing;
    }
  }
  return DEFAULT_PRICING;
};

/**
 * Computes the USD cost including cache token pricing.
 * Cache read tokens cost 0.1x the base input price.
 * Cache write tokens (5-minute TTL) cost 1.25x the base input price.
 */
export const calculateCost = (model: string, usage: TokenUsage): number => {
  const pricing = getPricing(model);

  // Standard input tokens at base rate
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;

  // Cache read tokens at 0.1x base rate
  const cacheReadCost =
    (usage.cacheReadInputTokens / 1_000_000) * pricing.inputPerMillion * 0.1;

  // Cache write tokens at 1.25x base rate
  const cacheWriteCost =
    (usage.cacheCreationInputTokens / 1_000_000) *
    pricing.inputPerMillion *
    1.25;

  // Output tokens at output rate
  const outputCost =
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;

  return inputCost + cacheReadCost + cacheWriteCost + outputCost;
};

/**
 * Estimates the cost for a given number of input and output tokens.
 */
export const estimateCost = (
  model: string,
  inputTokens: number,
  outputTokens: number
): number => {
  return calculateCost(model, {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
};
