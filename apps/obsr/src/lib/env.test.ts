import { afterEach, describe, expect, it, vi } from "vitest";
import { getResponsesApiConfig } from "./env";

const resetEnv = () => {
  vi.unstubAllEnvs();
  process.env.OPENAI_API_KEY = "";
  process.env.OBSR_OPENAI_API_KEY = "";
  process.env.OPENAI_BASE_URL = "";
  process.env.OBSR_OPENAI_BASE_URL = "";
  process.env.AI_GATEWAY_API_KEY = "";
  process.env.AI_GATEWAY_BASE_URL = "";
  process.env.OBSR_AI_GATEWAY_BASE_URL = "";
};

describe("getResponsesApiConfig", () => {
  afterEach(() => {
    resetEnv();
  });

  it("prefers direct OpenAI credentials when present", () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");

    expect(getResponsesApiConfig()).toEqual({
      apiKey: "openai-key",
      baseURL: "https://api.openai.com/v1",
      routingMode: "openai",
    });
  });

  it("falls back to AI Gateway when direct OpenAI credentials are absent", () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key");

    expect(getResponsesApiConfig()).toEqual({
      apiKey: "gateway-key",
      baseURL: "https://ai-gateway.vercel.sh/v1",
      routingMode: "gateway",
    });
  });
});
