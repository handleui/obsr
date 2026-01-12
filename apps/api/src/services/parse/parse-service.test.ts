import type { ExtractedError as ParserExtractedError } from "@detent/parser";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import type { Env } from "../../types/env";

// Mock functions for @detent/parser
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

// Mock database client
const mockDb = {
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  transaction: vi.fn(),
};
const mockClient = { end: vi.fn() };
const mockCreateDb = vi.fn();

vi.mock("../../db/client", () => ({
  createDb: (...args: unknown[]) => mockCreateDb(...args),
}));

// Mock Env object
const createMockEnv = (): Env =>
  ({
    HYPERDRIVE: { connectionString: "postgres://test" },
    GITHUB_APP_ID: "test",
    GITHUB_CLIENT_ID: "test",
    GITHUB_APP_PRIVATE_KEY: "test",
    GITHUB_WEBHOOK_SECRET: "test",
    WORKOS_CLIENT_ID: "test",
    WORKOS_API_KEY: "test",
    UPSTASH_REDIS_REST_URL: "test",
    UPSTASH_REDIS_REST_TOKEN: "test",
    RESEND_API_KEY: "test",
    APP_BASE_URL: "https://test.com",
  }) as unknown as Env;

const createError = (
  overrides: Partial<ParserExtractedError> = {}
): ParserExtractedError => ({
  message: "error",
  category: "lint",
  source: "generic",
  ...overrides,
});

const loadParseService = async () => (await import("./index")).parseService;

describe("parseService.parseAndPersist", () => {
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateDb.mockResolvedValue({ db: mockDb, client: mockClient });
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockDb) => Promise<void>) => {
        await fn(mockDb);
      }
    );
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("throws ValidationError when neither logs nor logZipBase64 provided", async () => {
    const parseService = await loadParseService();
    const { ValidationError } = await import("./types");

    await expect(
      parseService.parseAndPersist({}, createMockEnv())
    ).rejects.toThrow(ValidationError);

    await expect(
      parseService.parseAndPersist({}, createMockEnv())
    ).rejects.toThrow("logs or logZipBase64 is required");
  });

  it("rejects whitespace-only logs as missing input", async () => {
    const parseService = await loadParseService();
    const { ValidationError } = await import("./types");

    await expect(
      parseService.parseAndPersist({ logs: "   \n\t   " }, createMockEnv())
    ).rejects.toThrow(ValidationError);

    await expect(
      parseService.parseAndPersist({ logs: "   \n\t   " }, createMockEnv())
    ).rejects.toThrow("logs or logZipBase64 is required");
  });

  it("throws ParseTimeoutError when parsing exceeds 30 seconds", async () => {
    // Temporarily suppress unhandled rejection warnings for this test.
    // This is necessary because Promise.race with fake timers causes a timing
    // issue where the rejection fires before it can be caught synchronously.
    const originalListeners = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    const suppressedErrors: unknown[] = [];
    const handler = (error: unknown) => {
      suppressedErrors.push(error);
    };
    process.on("unhandledRejection", handler);

    vi.useFakeTimers();

    try {
      const parseService = await loadParseService();
      const { ParseTimeoutError } = await import("./types");

      // Mock parseGitHubLogs to return a promise that we control
      let resolveHanging: ((value: ParserExtractedError[]) => void) | undefined;
      const hangingPromise = new Promise<ParserExtractedError[]>((resolve) => {
        resolveHanging = resolve;
      });
      mockParseGitHubLogs.mockReturnValue(hangingPromise);

      const parsePromise = parseService.parseAndPersist(
        { logs: "##[error] test" },
        createMockEnv()
      );

      // Advance timers past the 30 second timeout
      await vi.advanceTimersByTimeAsync(30_001);

      // Catch the expected timeout error
      let caughtError: Error | null = null;
      try {
        await parsePromise;
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ParseTimeoutError);
      expect(caughtError?.message).toBe("Parse timeout exceeded");

      // Clean up: resolve the hanging promise
      resolveHanging?.([]);
    } finally {
      vi.useRealTimers();

      // Restore original rejection handlers
      process.removeListener("unhandledRejection", handler);
      for (const listener of originalListeners) {
        process.on("unhandledRejection", listener);
      }
    }
  });

  it("returns persisted: false when database fails", async () => {
    const parseService = await loadParseService();

    // Mock parser to return valid errors
    const errors = [createError({ message: "test error" })];
    mockParseGitHubLogs.mockReturnValue(errors);

    // Mock createDb to throw an error
    mockCreateDb.mockRejectedValue(new Error("Database connection failed"));

    const result = await parseService.parseAndPersist(
      { logs: "##[error] test error" },
      createMockEnv()
    );

    expect(result.persisted).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("test error");
    expect(result.summary.total).toBe(1);
  });

  it("parses logs and returns structured result with persistence", async () => {
    const parseService = await loadParseService();

    const errors = [
      createError({
        message: "TypeScript error: Cannot find name 'foo'",
        category: "type-check",
        source: "typescript",
        file: "src/app.ts",
        line: 10,
      }),
      createError({
        message: "ESLint: no-unused-vars",
        category: "lint",
        source: "eslint",
      }),
    ];
    mockParseGitHubLogs.mockReturnValue(errors);

    const result = await parseService.parseAndPersist(
      {
        logs: "##[error] TypeScript error\n::error::ESLint warning",
        repository: "owner/repo",
        commitSha: "abc123",
      },
      createMockEnv()
    );

    // Verify parse result structure
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.message).toBe(
      "TypeScript error: Cannot find name 'foo'"
    );
    expect(result.errors[0]?.filePath).toBe("src/app.ts");
    expect(result.errors[0]?.line).toBe(10);

    // Verify summary
    expect(result.summary.total).toBe(2);
    expect(result.summary.byCategory["type-check"]).toBe(1);
    expect(result.summary.byCategory.lint).toBe(1);
    expect(result.summary.bySource.typescript).toBe(1);
    expect(result.summary.bySource.eslint).toBe(1);

    // Verify metadata
    expect(result.metadata.format).toBe("github-actions");
    expect(result.metadata.source).toBe("github");
    expect(result.metadata.errorCount).toBe(2);

    // Verify persistence
    expect(result.persisted).toBe(true);
    expect(mockDb.transaction).toHaveBeenCalled();
  });

  it("persists errors in batches and closes db connection", async () => {
    const parseService = await loadParseService();

    const errors = [
      createError({ message: "error 1" }),
      createError({ message: "error 2" }),
    ];
    mockParseGitHubLogs.mockReturnValue(errors);

    await parseService.parseAndPersist(
      { logs: "##[error] test", projectId: "proj-123" },
      createMockEnv()
    );

    // Verify database was called
    expect(mockCreateDb).toHaveBeenCalledWith(createMockEnv());
    expect(mockDb.transaction).toHaveBeenCalled();

    // Verify connection was closed
    expect(mockClient.end).toHaveBeenCalled();
  });
});
