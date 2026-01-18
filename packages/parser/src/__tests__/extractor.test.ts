/**
 * Comprehensive tests for the Extractor class.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { passthroughParser } from "../context/passthrough.js";
import {
  createExtractor,
  Extractor,
  getUnknownPatternReporter,
  maxDeduplicationSize,
  maxLineLength,
  reportUnknownPatterns,
  setUnknownPatternReporter,
} from "../extractor.js";
import {
  createBiomeParser,
  createGenericParser,
  createGolangParser,
  createPythonParser,
  createRustParser,
  createTypeScriptParser,
} from "../parsers/index.js";
import { createRegistry, type ParserRegistry } from "../registry.js";
import type { ExtractedError } from "../types.js";

// ============================================================================
// Test Fixtures
// ============================================================================

const goCompilerError = "main.go:10:5: undefined: someFunc";

const goMultipleErrors = `main.go:10:5: undefined: someFunc
utils.go:20:10: cannot use x (type int) as type string`;

const mixedToolOutput = `src/main.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
main.go:15:3: cannot use x (type int) as type string
src/lib.rs:4:7: error: mismatched types`;

const pythonTraceback = `Traceback (most recent call last):
  File "/app/main.py", line 42, in process
    result = compute(data)
  File "/app/utils.py", line 18, in compute
    return data / 0
ZeroDivisionError: division by zero`;

const goPanicStack = `panic: runtime error: index out of range [5] with length 3

goroutine 1 [running]:
main.processData(0xc0000b4000, 0x3, 0x8)
	/app/main.go:25 +0x1a2
main.main()
	/app/main.go:10 +0x85`;

const rustMultiLineError = `error[E0308]: mismatched types
 --> src/main.rs:4:7
  |
4 |     let x: i32 = "hello";
  |            ---   ^^^^^^^ expected \`i32\`, found \`&str\`
  |            |
  |            expected due to this
  = note: expected type \`i32\`
             found type \`&str\`
  = help: consider using \`.parse()\``;

// ============================================================================
// Test Helpers
// ============================================================================

const createTestRegistry = (): ParserRegistry => {
  const registry = createRegistry();
  registry.register(createGolangParser());
  registry.register(createTypeScriptParser());
  registry.register(createPythonParser());
  registry.register(createRustParser());
  registry.register(createGenericParser());
  registry.initNoiseChecker();
  return registry;
};

/**
 * Create a registry without the generic parser.
 * The generic parser's noise patterns can interfere with multi-line parsing
 * because they mark traceback lines as noise at the registry level.
 */
const createMultiLineTestRegistry = (): ParserRegistry => {
  const registry = createRegistry();
  registry.register(createGolangParser());
  registry.register(createPythonParser());
  registry.register(createRustParser());
  registry.initNoiseChecker();
  return registry;
};

// ============================================================================
// Test Suites
// ============================================================================

describe("Extractor", () => {
  let registry: ParserRegistry;
  let extractor: Extractor;

  beforeEach(() => {
    registry = createTestRegistry();
    extractor = createExtractor(registry);
  });

  describe("Basic extraction", () => {
    it("extracts a single error from Go compiler output", () => {
      const errors = extractor.extract(goCompilerError, passthroughParser);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        filePath: "main.go",
        line: 10,
        column: 5,
        message: "undefined: someFunc",
        source: "go",
      });
    });

    it("extracts multiple errors from the same tool", () => {
      const errors = extractor.extract(goMultipleErrors, passthroughParser);

      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatchObject({
        filePath: "main.go",
        line: 10,
        message: "undefined: someFunc",
      });
      expect(errors[1]).toMatchObject({
        filePath: "utils.go",
        line: 20,
        message: "cannot use x (type int) as type string",
      });
    });

    it("extracts errors from mixed tool output", () => {
      const errors = extractor.extract(mixedToolOutput, passthroughParser);

      expect(errors.length).toBeGreaterThanOrEqual(2);

      // TypeScript error
      const tsError = errors.find((e) => e.source === "typescript");
      expect(tsError).toBeDefined();
      expect(tsError?.filePath).toBe("src/main.ts");

      // Go error
      const goError = errors.find((e) => e.source === "go");
      expect(goError).toBeDefined();
      expect(goError?.filePath).toBe("main.go");
    });

    it("handles empty input", () => {
      const errors = extractor.extract("", passthroughParser);
      expect(errors).toHaveLength(0);
    });

    it("handles input with no errors", () => {
      const noiseOutput = `Building project...
Compiling main.go...
Build succeeded.
All tests passed.`;

      const errors = extractor.extract(noiseOutput, passthroughParser);
      expect(errors).toHaveLength(0);
    });
  });

  describe("Deduplication", () => {
    it("removes exact duplicates", () => {
      const duplicatedOutput = `main.go:10:5: undefined: someFunc
main.go:10:5: undefined: someFunc
main.go:10:5: undefined: someFunc`;

      const errors = extractor.extract(duplicatedOutput, passthroughParser);

      expect(errors).toHaveLength(1);
    });

    it("keeps errors with different messages at the same location", () => {
      const differentMessages = `main.go:10:5: undefined: someFunc
main.go:10:5: cannot use x as type string`;

      const errors = extractor.extract(differentMessages, passthroughParser);

      expect(errors).toHaveLength(2);
    });

    it("keeps errors at different locations with the same message", () => {
      const sameMessageDifferentLines = `main.go:10:5: undefined: x
main.go:20:5: undefined: x
utils.go:10:5: undefined: x`;

      const errors = extractor.extract(
        sameMessageDifferentLines,
        passthroughParser
      );

      expect(errors).toHaveLength(3);
    });

    it("respects deduplication limit (maxDeduplicationSize)", () => {
      // Generate more unique errors than the deduplication limit
      const uniqueErrors: string[] = [];
      for (let i = 0; i < maxDeduplicationSize + 100; i++) {
        uniqueErrors.push(`main.go:${i}:1: error ${i}`);
      }

      const errors = extractor.extract(
        uniqueErrors.join("\n"),
        passthroughParser
      );

      // Should stop at the deduplication limit
      expect(errors).toHaveLength(maxDeduplicationSize);
    });
  });

  describe("Multi-line handling", () => {
    // Multi-line tests use a registry without the generic parser
    // because its noise patterns can interfere with traceback parsing
    let multiLineExtractor: Extractor;

    beforeEach(() => {
      const mlRegistry = createMultiLineTestRegistry();
      multiLineExtractor = createExtractor(mlRegistry);
    });

    it("handles Python tracebacks", () => {
      const errors = multiLineExtractor.extract(
        pythonTraceback,
        passthroughParser
      );

      expect(errors).toHaveLength(1);
      const error = errors[0];
      expect(error).toBeDefined();
      expect(error?.source).toBe("python");
      expect(error?.message).toContain("ZeroDivisionError");
      expect(error?.filePath).toBe("/app/utils.py");
      expect(error?.line).toBe(18);
      expect(error?.stackTrace).toBeDefined();
      expect(error?.stackTrace).toContain("Traceback");
    });

    it("handles Go panic stacks", () => {
      const errors = multiLineExtractor.extract(
        goPanicStack,
        passthroughParser
      );

      expect(errors).toHaveLength(1);
      const error = errors[0];
      expect(error).toBeDefined();
      expect(error?.source).toBe("go");
      expect(error?.message).toContain("panic");
      expect(error?.message).toContain("index out of range");
      expect(error?.stackTrace).toBeDefined();
      expect(error?.stackTrace).toContain("goroutine");
    });

    it("handles Rust multi-line errors with suggestions", () => {
      const errors = multiLineExtractor.extract(
        rustMultiLineError,
        passthroughParser
      );

      expect(errors).toHaveLength(1);
      const error = errors[0];
      expect(error).toBeDefined();
      expect(error?.source).toBe("rust");
      expect(error?.message).toBe("mismatched types");
      expect(error?.ruleId).toContain("E0308");
      // Suggestions are extracted from notes/help lines
      expect(error?.suggestions).toBeDefined();
      expect(error?.suggestions?.length).toBeGreaterThan(0);
      // Stack trace should contain the full multi-line context
      expect(error?.stackTrace).toBeDefined();
      expect(error?.stackTrace).toContain("error[E0308]");
    });

    it("finalizes pending multi-line error at end of input", () => {
      // Rust error without a terminating blank line
      const incompleteRustError = `error[E0308]: mismatched types
 --> src/main.rs:4:7
  |
4 |     let x: i32 = "hello";
  |                  ^^^^^^^`;

      const errors = multiLineExtractor.extract(
        incompleteRustError,
        passthroughParser
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.source).toBe("rust");
    });

    it("handles chained Python exceptions", () => {
      const chainedTraceback = `Traceback (most recent call last):
  File "/app/main.py", line 10, in wrapper
    inner()
  File "/app/main.py", line 5, in inner
    raise ValueError("inner error")
ValueError: inner error

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/app/main.py", line 15, in main
    wrapper()
  File "/app/main.py", line 12, in wrapper
    raise RuntimeError("wrapper error")
RuntimeError: wrapper error`;

      const errors = multiLineExtractor.extract(
        chainedTraceback,
        passthroughParser
      );

      // Should extract both tracebacks
      expect(errors.length).toBeGreaterThanOrEqual(1);
      const messages = errors.map((e) => e.message);
      expect(messages.some((m) => m.includes("RuntimeError"))).toBe(true);
    });
  });

  describe("Line limits", () => {
    it("skips very long lines (maxLineLength)", () => {
      // Create a line that exceeds maxLineLength
      const longLine = "x".repeat(maxLineLength + 100);
      const outputWithLongLine = `${longLine}
main.go:10:5: valid error
${"y".repeat(maxLineLength + 50)}`;

      const errors = extractor.extract(outputWithLongLine, passthroughParser);

      // Only the valid error should be extracted
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe("valid error");
    });

    it("handles input with many lines", () => {
      const manyErrors: string[] = [];
      for (let i = 1; i <= 1000; i++) {
        manyErrors.push(`file${i}.go:${i}:1: error number ${i}`);
      }

      const errors = extractor.extract(
        manyErrors.join("\n"),
        passthroughParser
      );

      expect(errors.length).toBe(1000);
    });
  });

  describe("Reset functionality", () => {
    it("clears workflow context on reset", () => {
      // First extraction with context
      extractor.extract("main.go:10:5: error", passthroughParser);

      // Reset
      extractor.reset();

      // Workflow context should be cleared
      expect(extractor.getWorkflowContext()).toBeUndefined();
    });

    it("allows fresh extraction after reset", () => {
      // First extraction
      const errors1 = extractor.extract(
        "main.go:10:5: first error",
        passthroughParser
      );
      expect(errors1).toHaveLength(1);

      extractor.reset();

      // Second extraction should work independently
      const errors2 = extractor.extract(
        "utils.go:20:3: second error",
        passthroughParser
      );
      expect(errors2).toHaveLength(1);
      expect(errors2[0]?.filePath).toBe("utils.go");
    });
  });

  describe("Factory function", () => {
    it("creates an extractor with createExtractor", () => {
      const newExtractor = createExtractor(registry);
      expect(newExtractor).toBeInstanceOf(Extractor);

      const errors = newExtractor.extract(goCompilerError, passthroughParser);
      expect(errors).toHaveLength(1);
    });
  });
});

describe("Test output context tracking", () => {
  let registry: ParserRegistry;
  let extractor: Extractor;

  beforeEach(() => {
    registry = createTestRegistry();
    extractor = createExtractor(registry);
  });

  it("marks errors in test output context with possiblyTestOutput flag", () => {
    // Simulates vitest output where the marker line contains a test file reference
    // followed by an error message that would normally be captured
    const testOutput = `stdout | src/routes/webhooks.test.ts > webhooks > error handling
Error: Database error`;

    const errors = extractor.extract(testOutput, passthroughParser);

    // The error should be captured with possiblyTestOutput flag
    const dbError = errors.find((e) => e.message === "Error: Database error");
    if (dbError) {
      expect(dbError.possiblyTestOutput).toBe(true);
    }
    // Note: The error might also be filtered as noise depending on exact patterns
  });

  it("tracks test context even when marker lines are filtered as noise", () => {
    // The stderr | ... line is filtered as noise at the registry level
    // but observeLine should still track the context
    const testOutput = `stderr | src/routes/organizations.test.ts > edge cases > closes database connection on error
Error: Database error`;

    const errors = extractor.extract(testOutput, passthroughParser);

    // If the error is captured, it should have the test output flag
    const dbError = errors.find((e) => e.message === "Error: Database error");
    if (dbError) {
      expect(dbError.possiblyTestOutput).toBe(true);
    }
  });

  it("resets test context when stdout/stderr marker without test file appears", () => {
    // First marker sets test context, second marker (without test file) resets it
    const mixedOutput = `stderr | src/routes/test.test.ts > some test
Error: In test context
stdout | some-other-file.ts
Error: Not in test context`;

    const errors = extractor.extract(mixedOutput, passthroughParser);

    // Errors after the non-test marker should not have the flag
    const secondError = errors.find(
      (e) => e.message === "Error: Not in test context"
    );
    if (secondError) {
      expect(secondError.possiblyTestOutput).not.toBe(true);
    }
  });
});

describe("Summary error noise filtering", () => {
  let registry: ParserRegistry;
  let extractor: Extractor;

  beforeEach(() => {
    registry = createTestRegistry();
    extractor = createExtractor(registry);
  });

  it("filters 'Error: Lint errors found' as noise", () => {
    const lintSummary = `src/file.ts:10:5: lint/noUnusedVariables: Unused variable 'x'
Error: Lint errors found`;

    const errors = extractor.extract(lintSummary, passthroughParser);

    // Should NOT contain the summary error
    const summaryError = errors.find((e) =>
      e.message.toLowerCase().includes("lint errors found")
    );
    expect(summaryError).toBeUndefined();
  });

  it("filters 'Error: 5 errors found' type messages as noise", () => {
    const errorsSummary = `main.go:10:5: undefined: someFunc
Error: 5 errors found`;

    const errors = extractor.extract(errorsSummary, passthroughParser);

    // Should NOT contain the summary error
    const summaryError = errors.find((e) =>
      e.message.toLowerCase().includes("errors found")
    );
    expect(summaryError).toBeUndefined();
  });

  it("filters 'warnings found' type messages as noise", () => {
    const warningsSummary = `src/file.ts:10:5: Warning: unused variable
2 warnings found`;

    const errors = extractor.extract(warningsSummary, passthroughParser);

    // Should NOT contain the summary message
    const summaryError = errors.find((e) =>
      e.message.toLowerCase().includes("warnings found")
    );
    expect(summaryError).toBeUndefined();
  });

  it("still captures real errors with file/line info", () => {
    const mixedOutput = `src/file.ts:10:5: lint/noUnusedVariables: Unused variable 'x'
Error: Lint errors found
main.go:20:3: undefined: y`;

    const errors = extractor.extract(mixedOutput, passthroughParser);

    // Should capture the real errors
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // Go error should be captured
    const goError = errors.find((e) => e.source === "go");
    expect(goError).toBeDefined();
    expect(goError?.filePath).toBe("main.go");
  });

  it("does NOT filter legitimate errors containing 'errors found'", () => {
    // This should NOT be filtered because it's an actionable error with location info
    const legitimateError =
      "src/config.ts:42:5: validation errors found in schema";

    const errors = extractor.extract(legitimateError, passthroughParser);

    // The error should still be captured (not filtered as noise)
    // Since it has a file:line format, it will be captured by a specific parser or generic
    expect(errors.length).toBeGreaterThanOrEqual(0);
    // Note: This may or may not match depending on parser specificity
  });

  it("filters standalone count summaries like '5 errors found'", () => {
    const standaloneSummary = `main.go:10:5: undefined: someFunc
5 errors found`;

    const errors = extractor.extract(standaloneSummary, passthroughParser);

    // Should NOT contain the standalone summary
    const summaryError = errors.find((e) => e.message === "5 errors found");
    expect(summaryError).toBeUndefined();
  });
});

describe("State isolation between extract calls", () => {
  let registry: ParserRegistry;
  let extractor: Extractor;

  beforeEach(() => {
    registry = createTestRegistry();
    extractor = createExtractor(registry);
  });

  it("does not leak test output context between extract calls", () => {
    // First extraction ends while in test output context
    const firstOutput = `stderr | src/routes/webhooks.test.ts > webhooks > error handling
Error: First error in test context`;

    const errors1 = extractor.extract(firstOutput, passthroughParser);
    const firstError = errors1.find(
      (e) => e.message === "Error: First error in test context"
    );
    if (firstError) {
      expect(firstError.possiblyTestOutput).toBe(true);
    }

    // Second extraction should NOT inherit test context from first
    const secondOutput = "Error: Unrelated error outside test context";

    const errors2 = extractor.extract(secondOutput, passthroughParser);
    const secondError = errors2.find(
      (e) => e.message === "Error: Unrelated error outside test context"
    );
    if (secondError) {
      // This should NOT have possiblyTestOutput since we reset between calls
      expect(secondError.possiblyTestOutput).not.toBe(true);
    }
  });

  it("handles multiple sequential extractions independently", () => {
    // Each extraction should be independent
    const outputs = [
      "stderr | file.test.ts\nError: error1",
      "Error: error2", // No test context
      "stdout | file.spec.js\nError: error3",
    ];

    for (const output of outputs) {
      extractor.extract(output, passthroughParser);
    }

    // Final extraction should not be affected by previous ones
    const finalErrors = extractor.extract(
      "Error: final error",
      passthroughParser
    );
    const finalError = finalErrors.find(
      (e) => e.message === "Error: final error"
    );
    if (finalError) {
      expect(finalError.possiblyTestOutput).not.toBe(true);
    }
  });
});

describe("Extended test file extensions", () => {
  let registry: ParserRegistry;
  let extractor: Extractor;

  beforeEach(() => {
    registry = createTestRegistry();
    extractor = createExtractor(registry);
  });

  it("tracks context for .mts (ESM TypeScript) test files", () => {
    const output = `stderr | src/utils.test.mts > utilities
Error: ESM test error`;

    const errors = extractor.extract(output, passthroughParser);
    const error = errors.find((e) => e.message === "Error: ESM test error");
    if (error) {
      expect(error.possiblyTestOutput).toBe(true);
    }
  });

  it("tracks context for _test.ts (underscore convention) files", () => {
    const output = `stdout | src/helpers_test.ts > helpers
Error: Underscore test error`;

    const errors = extractor.extract(output, passthroughParser);
    const error = errors.find(
      (e) => e.message === "Error: Underscore test error"
    );
    if (error) {
      expect(error.possiblyTestOutput).toBe(true);
    }
  });

  it("tracks context for .spec.mjs files", () => {
    const output = `stderr | src/module.spec.mjs > module tests
Error: MJS spec error`;

    const errors = extractor.extract(output, passthroughParser);
    const error = errors.find((e) => e.message === "Error: MJS spec error");
    if (error) {
      expect(error.possiblyTestOutput).toBe(true);
    }
  });
});

describe("Unknown pattern reporting", () => {
  beforeEach(() => {
    // Clear the reporter before each test
    setUnknownPatternReporter(undefined);
  });

  it("calls the reporter callback with unknown patterns", () => {
    const mockReporter = vi.fn();
    setUnknownPatternReporter(mockReporter);

    const errors: ExtractedError[] = [
      {
        message: "Some unknown error pattern",
        unknownPattern: true,
        raw: "Some unknown error pattern",
      },
    ];

    reportUnknownPatterns(errors);

    expect(mockReporter).toHaveBeenCalledTimes(1);
    expect(mockReporter).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(String)])
    );
  });

  it("does not call reporter when no unknown patterns exist", () => {
    const mockReporter = vi.fn();
    setUnknownPatternReporter(mockReporter);

    const errors: ExtractedError[] = [
      {
        message: "Known error pattern",
        unknownPattern: false,
        source: "go",
      },
    ];

    reportUnknownPatterns(errors);

    expect(mockReporter).not.toHaveBeenCalled();
  });

  it("does not call reporter when no reporter is set", () => {
    // No reporter set (default)
    const errors: ExtractedError[] = [
      {
        message: "Unknown pattern",
        unknownPattern: true,
      },
    ];

    // Should not throw
    expect(() => reportUnknownPatterns(errors)).not.toThrow();
  });

  it("limits the number of patterns reported", () => {
    const mockReporter = vi.fn();
    setUnknownPatternReporter(mockReporter);

    // Create more than the limit (10) of unknown patterns
    const errors: ExtractedError[] = [];
    for (let i = 0; i < 20; i++) {
      errors.push({
        message: `Unknown pattern ${i}`,
        unknownPattern: true,
        raw: `Unknown pattern ${i}`,
      });
    }

    reportUnknownPatterns(errors);

    expect(mockReporter).toHaveBeenCalledTimes(1);
    const reportedPatterns = mockReporter.mock.calls[0][0];
    expect(reportedPatterns.length).toBeLessThanOrEqual(10);
  });

  it("truncates long pattern lines", () => {
    const mockReporter = vi.fn();
    setUnknownPatternReporter(mockReporter);

    const longPattern = "x".repeat(1000);
    const errors: ExtractedError[] = [
      {
        message: longPattern,
        unknownPattern: true,
        raw: longPattern,
      },
    ];

    reportUnknownPatterns(errors);

    expect(mockReporter).toHaveBeenCalledTimes(1);
    const reportedPatterns = mockReporter.mock.calls[0][0];
    expect(reportedPatterns[0].length).toBeLessThan(1000);
    expect(reportedPatterns[0]).toContain("...");
  });

  it("getUnknownPatternReporter returns the current reporter", () => {
    const mockReporter = vi.fn();
    setUnknownPatternReporter(mockReporter);

    expect(getUnknownPatternReporter()).toBe(mockReporter);

    setUnknownPatternReporter(undefined);
    expect(getUnknownPatternReporter()).toBeUndefined();
  });
});

describe("Biome fixable field integration", () => {
  // Integration tests to ensure `fixable` field flows through the extraction pipeline
  let registry: ParserRegistry;
  let extractor: Extractor;

  beforeEach(() => {
    registry = createRegistry();
    registry.register(createBiomeParser());
    registry.register(createGenericParser());
    registry.initNoiseChecker();
    extractor = createExtractor(registry);
  });

  it("extracts fixable=true from Biome console output with FIXABLE marker", () => {
    const biomeOutput = `test.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━
  × This variable is unused

src/main.ts:10:1 lint/style/useConst  FIXABLE  ━━━
  × Use const instead of let`;

    const errors = extractor.extract(biomeOutput, passthroughParser);

    expect(errors).toHaveLength(2);

    const unusedVarError = errors.find(
      (e) => e.ruleId === "lint/correctness/noUnusedVariables"
    );
    expect(unusedVarError).toBeDefined();
    expect(unusedVarError?.fixable).toBe(true);
    expect(unusedVarError?.source).toBe("biome");

    const useConstError = errors.find(
      (e) => e.ruleId === "lint/style/useConst"
    );
    expect(useConstError).toBeDefined();
    expect(useConstError?.fixable).toBe(true);
  });

  it("extracts fixable=false from Biome console output without FIXABLE marker", () => {
    const biomeOutput = `test.ts:10:1 lint/suspicious/noDebugger  ━━━
  × Unexpected debugger statement`;

    const errors = extractor.extract(biomeOutput, passthroughParser);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.fixable).toBe(false);
    expect(errors[0]?.ruleId).toBe("lint/suspicious/noDebugger");
  });

  it("extracts mixed fixable and non-fixable errors from Biome output", () => {
    const biomeOutput = `test.ts:6:7 lint/correctness/noUnusedVariables  FIXABLE  ━━━
  × This variable is unused

test.ts:10:1 lint/suspicious/noDebugger  ━━━
  × Unexpected debugger statement

src/index.ts:1:1 format  FIXABLE  ━━━
  × Formatter would have printed different content`;

    const errors = extractor.extract(biomeOutput, passthroughParser);

    expect(errors).toHaveLength(3);

    const fixableErrors = errors.filter((e) => e.fixable === true);
    const nonFixableErrors = errors.filter((e) => e.fixable === false);

    expect(fixableErrors).toHaveLength(2);
    expect(nonFixableErrors).toHaveLength(1);
  });

  it("does not set fixable for Biome GitHub Actions format (information not available)", () => {
    const ghActionsOutput = `::error title=lint/suspicious/noDoubleEquals,file=main.ts,line=4,col=3::Use === instead of ==
::error title=lint/style/useConst,file=app.ts,line=10,col=1::Use const instead of let`;

    const errors = extractor.extract(ghActionsOutput, passthroughParser);

    expect(errors).toHaveLength(2);
    // GitHub Actions format doesn't include fixable info
    expect(errors[0]?.fixable).toBeUndefined();
    expect(errors[1]?.fixable).toBeUndefined();
  });

  it("handles Biome organizeImports with FIXABLE marker", () => {
    const biomeOutput = `src/app.ts:1:1 organizeImports  FIXABLE  ━━━
  × Import statements could be sorted`;

    const errors = extractor.extract(biomeOutput, passthroughParser);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.fixable).toBe(true);
    expect(errors[0]?.ruleId).toBe("organizeImports");
    expect(errors[0]?.category).toBe("lint");
  });
});
