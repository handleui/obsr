import { afterEach, describe, expect, it, vi } from "vitest";
import { generateIssueSnapshot } from "./snapshot.js";

const createResponse = vi.fn();

vi.mock("openai", () => {
  return {
    default: class OpenAI {
      responses = {
        create: createResponse,
      };
    },
  };
});

const createDiagnostic = (index: number) => ({
  fingerprint: `fp-${index}`,
  repoFingerprint: `repo-${index}`,
  loreFingerprint: `lore-${index}`,
  message: `Diagnostic ${index}`,
  severity: "error" as const,
  category: "runtime" as const,
  source: "vitest",
  ruleId: `RULE_${index}`,
  filePath: `src/file-${index}.ts`,
  line: index,
  column: 1,
  evidence: `evidence ${index}`,
});

describe("generateIssueSnapshot", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("skips the model when there are no diagnostics", async () => {
    const result = await generateIssueSnapshot(
      {
        diagnostics: [],
        observations: [],
        relatedIssues: [],
      },
      {
        apiKey: "test-key",
      }
    );

    expect(result).toBeNull();
    expect(createResponse).not.toHaveBeenCalled();
  });

  it("caps synthesis context and uses privacy-safe Responses defaults", async () => {
    createResponse.mockResolvedValue({
      model: "gpt-5.2-codex",
      output_text: JSON.stringify({
        title: "Runtime issue",
        severity: "medium",
        summary: "Primary runtime issue summary.",
        rootCause: "Primary runtime issue root cause.",
        plan: {
          summary: "Fix it.",
          steps: ["Step 1"],
          validation: ["Validation 1"],
          blockers: [],
        },
      }),
      usage: null,
    });

    await generateIssueSnapshot(
      {
        diagnostics: Array.from({ length: 12 }, (_, index) =>
          createDiagnostic(index + 1)
        ),
        observations: Array.from({ length: 9 }, (_, index) => ({
          sourceKind: "ci" as const,
          context: {
            environment: "ci" as const,
            repo: `repo-${index + 1}`,
            command: `command-${index + 1}`,
          },
        })),
        relatedIssues: Array.from({ length: 7 }, (_, index) => ({
          title: `Issue ${index + 1}`,
          summary: `Summary ${index + 1}`,
          matchReason: `Reason ${index + 1}`,
          status: "open" as const,
          severity: "medium" as const,
        })),
      },
      {
        apiKey: "test-key",
      }
    );

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.2-codex",
        reasoning: {
          effort: "minimal",
        },
        store: false,
      }),
      expect.any(Object)
    );

    const request = createResponse.mock.calls[0]?.[0];
    const userPrompt = request.input[1].content as string;
    const payload = JSON.parse(userPrompt);

    expect(payload.diagnostics).toHaveLength(8);
    expect(payload.observations).toHaveLength(6);
    expect(payload.relatedIssues).toHaveLength(5);
  });
});
