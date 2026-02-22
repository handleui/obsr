import type { LanguageModel } from "ai";
import type { TokenUsage } from "./types.js";

export type ModelParam = string | LanguageModel;

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

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

const DEFAULT_PRICING: ModelPricing = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
};

export const extractModelId = (model: ModelParam): string => {
  if (typeof model === "string") {
    return model;
  }
  // LanguageModel object: prefer modelId, fall back to provider
  return model.modelId ?? model.provider ?? "";
};

const normalizeModelName = (model: ModelParam): string => {
  const modelId = extractModelId(model);
  const parts = modelId.split("/");
  if (parts.length <= 1) {
    return modelId;
  }
  return parts.at(-1) ?? modelId;
};

const getPricing = (model: ModelParam): ModelPricing => {
  const normalized = normalizeModelName(model);
  for (const { prefix, pricing } of MODEL_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return pricing;
    }
  }
  return DEFAULT_PRICING;
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;
const TOKENS_PER_MILLION = 1_000_000;

export const calculateCost = (model: ModelParam, usage: TokenUsage): number => {
  const pricing = getPricing(model);

  const inputCost =
    (usage.inputTokens / TOKENS_PER_MILLION) * pricing.inputPerMillion;
  const cacheReadCost =
    (usage.cacheReadInputTokens / TOKENS_PER_MILLION) *
    pricing.inputPerMillion *
    CACHE_READ_MULTIPLIER;
  const cacheWriteCost =
    (usage.cacheCreationInputTokens / TOKENS_PER_MILLION) *
    pricing.inputPerMillion *
    CACHE_WRITE_MULTIPLIER;
  const outputCost =
    (usage.outputTokens / TOKENS_PER_MILLION) * pricing.outputPerMillion;

  return inputCost + cacheReadCost + cacheWriteCost + outputCost;
};

export const estimateCost = (
  model: ModelParam,
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
