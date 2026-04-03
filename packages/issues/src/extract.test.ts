import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractIssueDiagnostics } from "./extract.js";

const createResponse = vi.fn();
const dirname = fileURLToPath(new URL(".", import.meta.url));

vi.mock("openai", () => {
  return {
    default: class OpenAI {
      responses = {
        create: createResponse,
      };
    },
  };
});

describe("extractIssueDiagnostics", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("maps structured response content into issue-native diagnostics", async () => {
    createResponse.mockResolvedValue({
      model: "openai/gpt-5.2-codex",
      output_text: JSON.stringify({
        diagnostics: [
          {
            message: "Type 'string' is not assignable to type 'number'.",
            severity: "error",
            category: "type-check",
            source: "typescript",
            ruleId: "TS2322",
            filePath: "src/app/page.tsx",
            line: 12,
            column: 5,
            evidence:
              "src/app/page.tsx:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
          },
        ],
      }),
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
      },
    });

    const result = await extractIssueDiagnostics("error TS2322", {
      apiKey: "test-key",
      model: "openai/gpt-5.2-codex",
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      message: "Type 'string' is not assignable to type 'number'.",
      category: "type-check",
      source: "typescript",
      ruleId: "TS2322",
      filePath: "src/app/page.tsx",
      line: 12,
      column: 5,
    });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.2-codex",
        reasoning: {
          effort: "minimal",
        },
        store: false,
        truncation: "disabled",
      }),
      expect.any(Object)
    );
  });

  it("throws when the model returns no structured text", async () => {
    createResponse.mockResolvedValue({
      model: "openai/gpt-5.2-codex",
      output_text: "",
      output: [],
      usage: null,
    });

    await expect(
      extractIssueDiagnostics("error TS2322", {
        apiKey: "test-key",
      })
    ).rejects.toThrow("Issue extraction failed");
  });

  it("throws when the model refuses structured output", async () => {
    createResponse.mockResolvedValue({
      model: "gpt-4o-mini",
      output: [
        {
          type: "message",
          content: [
            {
              type: "refusal",
              refusal: "I cannot help with that.",
            },
          ],
        },
      ],
      usage: null,
    });

    await expect(
      extractIssueDiagnostics("suspicious input", {
        apiKey: "test-key",
      })
    ).rejects.toThrow("Issue extraction failed refused");
  });

  it("throws on malformed structured output", async () => {
    createResponse.mockResolvedValue({
      model: "openai/gpt-5.2-codex",
      output_text: "{not-json",
      usage: null,
    });

    await expect(
      extractIssueDiagnostics("error TS2322", {
        apiKey: "test-key",
      })
    ).rejects.toThrow("Issue extraction failed");
  });

  it("passes prompt cache and safety identifiers through to Responses", async () => {
    createResponse.mockResolvedValue({
      model: "openai/gpt-5.2-codex",
      output_text: JSON.stringify({
        diagnostics: [],
      }),
      usage: null,
    });

    await extractIssueDiagnostics("error TS2322", {
      apiKey: "test-key",
      promptCacheKey: "obsr:issues:extract:ci",
      safetyIdentifier: "safe-user",
    });

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        prompt_cache_key: "obsr:issues:extract:ci",
        safety_identifier: "safe-user",
      }),
      expect.any(Object)
    );
  });

  it("throws a specific error when structured output is incomplete", async () => {
    createResponse.mockResolvedValue({
      model: "openai/gpt-5.2-codex",
      status: "incomplete",
      incomplete_details: {
        reason: "max_output_tokens",
      },
      output: [],
      usage: null,
    });

    await expect(
      extractIssueDiagnostics("error TS2322", {
        apiKey: "test-key",
      })
    ).rejects.toThrow("Issue extraction failed incomplete");
  });

  it("throws a specific error when structured output is refused", async () => {
    createResponse.mockResolvedValue({
      model: "openai/gpt-5.2-codex",
      refusal: "I can’t help with that request.",
      output: [],
      usage: null,
    });

    await expect(
      extractIssueDiagnostics("error TS2322", {
        apiKey: "test-key",
      })
    ).rejects.toThrow("Issue extraction failed refused");
  });

  it("preserves the existing fixture flow with issue-native output", async () => {
    createResponse.mockResolvedValue({
      model: "openai/gpt-5.2-codex",
      output_text: JSON.stringify({
        diagnostics: [
          {
            message: "Cannot find name 'describe'.",
            severity: "error",
            category: "type-check",
            source: "typescript",
            ruleId: "TS2593",
            filePath: "src/example.test.ts",
            line: 7,
            column: 1,
            evidence:
              "src/example.test.ts:7:1 - error TS2593: Cannot find name 'describe'.",
          },
          {
            message: "Unused variable 'value'.",
            severity: "warning",
            category: "lint",
            source: "biome",
            ruleId: "noUnusedVariables",
            filePath: "src/example.ts",
            line: 3,
            column: 7,
            evidence:
              "src/example.ts:3:7 lint/noUnusedVariables  FIXABLE  Unused variable 'value'.",
          },
        ],
      }),
      usage: null,
    });

    const fixture = readFileSync(
      join(dirname, "eval/fixtures/typescript-biome-vitest.txt"),
      "utf8"
    );
    const result = await extractIssueDiagnostics(fixture, {
      apiKey: "test-key",
    });

    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.category)).toEqual(
      ["type-check", "lint"]
    );
  });
});
