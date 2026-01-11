import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractedError as ParserExtractedError } from "@detent/parser";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockParse = vi.fn();
const mockParseActLogs = vi.fn();
const mockParseGitHubLogs = vi.fn();
const mockResetDefaultExtractor = vi.fn();
const mockExtractSnippetsForErrors = vi.fn();

vi.mock("@detent/parser", async () => {
  const actual =
    await vi.importActual<typeof import("@detent/parser")>("@detent/parser");
  return {
    ...actual,
    parse: (...args: unknown[]) => mockParse(...args),
    parseActLogs: (...args: unknown[]) => mockParseActLogs(...args),
    parseGitHubLogs: (...args: unknown[]) => mockParseGitHubLogs(...args),
    extractSnippetsForErrors: (...args: unknown[]) =>
      mockExtractSnippetsForErrors(...args),
    resetDefaultExtractor: (...args: unknown[]) =>
      mockResetDefaultExtractor(...args),
  };
});

const createError = (
  overrides: Partial<ParserExtractedError> = {}
): ParserExtractedError => ({
  message: "error",
  category: "lint",
  source: "generic",
  ...overrides,
});

const loadParseService = async () => (await import("./parser")).parseService;

describe("parseService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("infers act format and summarizes errors", async () => {
    const logs = "[job/step] act failure";
    const errors = [createError({ message: "act error" })];
    mockParseActLogs.mockReturnValue(errors);

    const parseService = await loadParseService();
    const result = await parseService.parse({
      logs,
      format: "auto",
      source: "auto",
    });

    expect(mockResetDefaultExtractor).toHaveBeenCalled();
    expect(mockParseActLogs).toHaveBeenCalledWith(logs);
    expect(result.metadata.format).toBe("act");
    expect(result.metadata.source).toBe("unknown");
    expect(result.summary.total).toBe(1);
    expect(result.summary.byCategory.lint).toBe(1);
    expect(result.summary.bySource.generic).toBe(1);
  });

  it("infers github-actions when logs include GitHub signals", async () => {
    const logs = "##[error] build failed";
    mockParseGitHubLogs.mockReturnValue([]);

    const parseService = await loadParseService();
    const result = await parseService.parse({
      logs,
      format: "auto",
      source: "auto",
    });

    expect(mockParseGitHubLogs).toHaveBeenCalledWith(logs);
    expect(result.metadata.format).toBe("github-actions");
    expect(result.metadata.source).toBe("github");
    expect(result.summary.total).toBe(0);
  });

  it("honors explicit format and source overrides", async () => {
    const logs = "##[error] forced gitlab";
    const errors = [
      createError({
        message: "gitlab error",
        category: "unknown",
        source: "typescript",
      }),
    ];
    mockParse.mockReturnValue(errors);

    const parseService = await loadParseService();
    const result = await parseService.parse({
      logs,
      format: "gitlab",
      source: "gitlab",
    });

    expect(mockParse).toHaveBeenCalledWith(logs);
    expect(result.metadata.format).toBe("gitlab");
    expect(result.metadata.source).toBe("gitlab");
    expect(result.summary.byCategory.unknown).toBe(1);
    expect(result.summary.bySource.typescript).toBe(1);
  });

  it("extracts snippets when workspacePath is provided", async () => {
    const workspacePath = join(tmpdir(), "detent-parser-workspace");
    const error = createError({
      message: "snippet error",
      file: "src/app.ts",
      line: 2,
      category: "lint",
      source: "typescript",
    });

    mockParseActLogs.mockReturnValue([error]);
    mockExtractSnippetsForErrors.mockResolvedValue({
      errors: [
        {
          ...error,
          codeSnippet: {
            lines: ["const b = 2;"],
            startLine: 1,
            errorLine: 2,
            language: "typescript",
          },
        },
      ],
      succeeded: 1,
      failed: 0,
    });

    const parseService = await loadParseService();
    const result = await parseService.parse({
      logs: "[job/step] act failure",
      format: "auto",
      source: "auto",
      workspacePath,
    });

    const snippet = result.errors[0]?.codeSnippet;
    expect(mockExtractSnippetsForErrors).toHaveBeenCalledWith(
      [error],
      workspacePath
    );
    expect(snippet?.lines).toContain("const b = 2;");
    expect(snippet?.startLine).toBeGreaterThanOrEqual(1);
    expect(snippet?.errorLine).toBeGreaterThan(0);
  });
});
