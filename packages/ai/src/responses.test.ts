import { zodTextFormat } from "openai/helpers/zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AI_GATEWAY_RESPONSES_BASE_URL,
  createStructuredResponse,
  parseStructuredOutput,
  resolveResponsesModel,
} from "./responses.js";

const createResponse = vi.fn();
const issueExtractionTextFormat = zodTextFormat(
  z.object({
    diagnostics: z.array(z.unknown()),
  }),
  "issue_extraction"
);

vi.mock("openai", () => {
  return {
    default: class OpenAI {
      responses = {
        create: createResponse,
      };
    },
  };
});

describe("responses runtime", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("uses direct OpenAI model names when no gateway base URL is configured", () => {
    expect(
      resolveResponsesModel({
        model: "openai/gpt-5.2-codex",
      })
    ).toBe("gpt-5.2-codex");
  });

  it("keeps provider-prefixed model names when using AI Gateway", () => {
    expect(
      resolveResponsesModel({
        model: "openai/gpt-5.2-codex",
        baseURL: AI_GATEWAY_RESPONSES_BASE_URL,
      })
    ).toBe("openai/gpt-5.2-codex");
  });

  it("keeps provider-prefixed model names when gateway routing is explicit", () => {
    expect(
      resolveResponsesModel({
        model: "anthropic/claude-haiku-4-5",
        baseURL: "https://gateway.example.com/v1",
        routingMode: "gateway",
      })
    ).toBe("anthropic/claude-haiku-4-5");
  });

  it("rejects non-OpenAI provider models without AI Gateway routing", () => {
    expect(() =>
      resolveResponsesModel({
        model: "anthropic/claude-haiku-4-5",
      })
    ).toThrow("Direct Responses API requests require an OpenAI model.");
  });

  it("sends stateless structured requests with disabled truncation", async () => {
    createResponse.mockResolvedValue({
      model: "gpt-5.2-codex",
      output_text: JSON.stringify({
        diagnostics: [],
      }),
      usage: null,
    });

    await createStructuredResponse({
      options: {
        apiKey: "test-key",
        model: "openai/gpt-5.2-codex",
      },
      request: {
        system: "Return JSON.",
        prompt: "[]",
        textFormat: issueExtractionTextFormat,
      },
    });

    expect(createResponse).toHaveBeenCalledTimes(1);
    const request = createResponse.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(request).toMatchObject({
      model: "gpt-5.2-codex",
      store: false,
      truncation: "disabled",
    });
  });

  it("fails fast on incomplete structured output", () => {
    expect(() =>
      parseStructuredOutput(
        {
          status: "incomplete",
          incomplete_details: {
            reason: "max_output_tokens",
          },
          output_text: JSON.stringify({ diagnostics: [] }),
        },
        issueExtractionTextFormat
      )
    ).toThrow("Structured output incomplete: max_output_tokens");
  });

  it("fails fast on structured output refusal", () => {
    expect(() =>
      parseStructuredOutput(
        {
          output: [
            {
              content: [
                {
                  refusal: "I can’t help with that.",
                },
              ],
            },
          ],
        },
        issueExtractionTextFormat
      )
    ).toThrow("Structured output refused: I can’t help with that.");
  });

  it("fails fast when structured output is missing a payload", () => {
    expect(() =>
      parseStructuredOutput(
        {
          output_text: "",
          output: [],
        },
        issueExtractionTextFormat
      )
    ).toThrow("Structured output missing payload");
  });
});
