import { describe, expect, it } from "vitest";
import { calculateCost, estimateCost } from "./pricing.js";

describe("calculateCost", () => {
  it("calculates cost for claude-haiku-4-5", () => {
    const cost = calculateCost("anthropic/claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    // $1.00 input + $5.00 output = $6.00
    expect(cost).toBe(6.0);
  });

  it("calculates cost with cache tokens", () => {
    const cost = calculateCost("anthropic/claude-haiku-4-5", {
      inputTokens: 500_000,
      outputTokens: 500_000,
      cacheCreationInputTokens: 100_000,
      cacheReadInputTokens: 200_000,
    });
    // $0.50 input + $2.50 output + $0.125 cache write + $0.02 cache read = $3.145
    expect(cost).toBeCloseTo(3.145, 3);
  });

  it("uses default pricing for unknown models", () => {
    const cost = calculateCost("unknown-model", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    // Default is sonnet pricing: $3.00 input + $15.00 output = $18.00
    expect(cost).toBe(18.0);
  });
});

describe("estimateCost", () => {
  it("estimates cost without cache tokens", () => {
    const cost = estimateCost("openai/gpt-5.2-codex", 1_000_000, 1_000_000);
    // $1.75 input + $14.00 output = $15.75
    expect(cost).toBe(15.75);
  });
});
