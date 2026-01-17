/**
 * @detent/parser - TypeScript error extraction library
 *
 * Architecture:
 * - context/  : CI log FORMAT parsers (act, github, passthrough)
 * - parsers/  : Tool error CONTENT parsers (go, ts, python, etc.)
 * - events/   : CI event types (job, step, manifest)
 */

// ============================================================================
// Context Parsers (CI log FORMAT)
// ============================================================================

export type {
  CIProvider,
  CIProviderID,
  ContextParser,
  LineContext,
  ParseLineResult,
} from "./context/index.js";

export {
  actParser,
  actProvider,
  addCIProvider,
  createActParser,
  createGitHubContextParser,
  createGitLabContextParser,
  createPassthroughParser,
  detectCIProvider,
  getAllProviders,
  getCIProviderName,
  getCIProviders,
  getProviderByID,
  githubParser,
  githubProvider,
  gitlabParser,
  gitlabProvider,
  isCI,
  passthroughParser,
  passthroughProvider,
  removeCIProvider,
  resetCIProviders,
} from "./context/index.js";

// ============================================================================
// CI Events (job/step lifecycle)
// ============================================================================

export type {
  JobEvent,
  JobStatus,
  ManifestEvent,
  ManifestInfo,
  ManifestJob,
  StepEvent,
  StepStatus,
} from "./events/index.js";

export { JobStatuses, StepStatuses } from "./events/index.js";

// ============================================================================
// Tool Parsers (error CONTENT)
// ============================================================================

export {
  createESLintParser,
  createGenericParser,
  createGolangParser,
  createInfrastructureParser,
  createPythonParser,
  createRustParser,
  createTypeScriptParser,
  createVitestParser,
  GolangParser,
  PythonParser,
  TypeScriptParser,
  VitestParser,
} from "./parsers/index.js";

// ============================================================================
// Core Types
// ============================================================================

export type { UnknownPatternReporter } from "./extractor.js";
export type {
  NoisePatternProvider,
  NoisePatterns,
  ParseContext,
  ParseResult,
  ToolParser,
} from "./parser-types.js";
export type {
  DetectedTool,
  DetectionOptions,
  DetectionResult,
} from "./registry.js";
export type { SerializeOptions } from "./serialize.js";
export type {
  AIContext,
  CodeSnippet,
  ComprehensiveErrorGroup,
  ErrorCategory,
  ErrorReport,
  ErrorSeverity,
  ErrorSource,
  ErrorStats,
  ExtractedError,
  GroupedErrors,
  MutableExtractedError,
  OrchestratorView,
  WorkflowContext,
} from "./types.js";

// ============================================================================
// Core Utilities
// ============================================================================

export {
  createExtractor,
  Extractor,
  getUnknownPatternReporter,
  maxDeduplicationSize,
  maxLineLength,
  reportUnknownPatterns,
  setUnknownPatternReporter,
} from "./extractor.js";
export {
  applyWorkflowContext,
  BaseParser,
  cloneParseContext,
  createParseContext,
  MultiLineParser,
} from "./parser-types.js";
export type { ToolPattern } from "./registry.js";
export {
  addToolPattern,
  addToolPatterns,
  allSupported,
  createRegistry,
  detectAllToolsFromRun,
  detectToolFromRun,
  firstTool,
  firstToolID,
  formatUnsupportedToolsWarning,
  getToolPatterns,
  getUnsupportedToolDisplayName,
  hasTools,
  isUnsupportedToolID,
  ParserRegistry,
  resetToolPatterns,
  unsupportedTools,
} from "./registry.js";
export type { RedactionPattern } from "./sanitize.js";
export {
  redactErrorMessage,
  redactionPatterns,
  redactPII,
  redactReport,
  redactSensitiveData,
  sanitizeForTelemetry,
} from "./sanitize.js";
export {
  formatErrorCompact,
  formatErrorsCompact,
  redactSensitive,
  serializeError,
  serializeErrorsNDJSON,
  serializeReport,
  stripAnsiFromError,
  stripAnsiFromReport,
} from "./serialize.js";
export {
  applySeverity,
  applySeverityToError,
  inferSeverity,
  withInferredSeverity,
} from "./severity.js";
export {
  DefaultContextLines,
  extractSnippet,
  extractSnippetsForErrors,
  MaxFileSize,
  MaxLineLength,
  MaxSnippetSize,
} from "./snippet.js";
export {
  AllCategories,
  cloneWorkflowContext,
  createErrorReport,
  createOrchestratorView,
  ErrorSources,
  filterByCategory,
  filterByFile,
  filterBySeverity,
  filterBySource,
  freezeError,
  groupByFile,
  groupErrors,
  isValidCategory,
  makeRelative,
} from "./types.js";
export {
  addExtensionMapping,
  addExtensionMappings,
  extensionToParserID,
  extractFileExtension,
  getExtensionMapping,
  getExtensionMappings,
  parseLocation,
  patterns,
  resetExtensionMappings,
  safeParseInt,
  splitCommands,
  stripAnsi,
} from "./utils.js";

// ============================================================================
// Default Registry Factory
// ============================================================================

import {
  createBiomeParser,
  createESLintParser,
  createGenericParser,
  createGitHubAnnotationParser,
  createGolangParser,
  createInfrastructureParser,
  createPythonParser,
  createRustParser,
  createTypeScriptParser,
  createVitestParser,
} from "./parsers/index.js";
import { createRegistry, type ParserRegistry } from "./registry.js";

/**
 * Create a parser registry with all default parsers registered.
 * Parsers are registered in priority order (automatic sorting by registry).
 *
 * Priority order (highest to lowest):
 * - GitHub Annotations (95): ::error file=...:: format (Vitest/Jest GitHub reporters)
 * - Language-specific (80): Go, Python, Rust, TypeScript, Vitest
 * - Linter (75): Biome, ESLint
 * - Infrastructure (70): CI/CD infrastructure failures
 * - Generic (10): Fallback for unknown formats
 */
export const createDefaultRegistry = (): ParserRegistry => {
  const registry = createRegistry();

  // GitHub Actions annotation parser (priority 95)
  // Handles ::error file=...:: format from test frameworks and linters
  registry.register(createGitHubAnnotationParser());

  // Language-specific parsers (priority 80)
  registry.register(createGolangParser());
  registry.register(createPythonParser());
  registry.register(createRustParser());
  registry.register(createTypeScriptParser());
  registry.register(createVitestParser());

  // Linter parsers (priority 75)
  registry.register(createBiomeParser());
  registry.register(createESLintParser());

  // Infrastructure parser (priority 70) - CI/CD failures
  registry.register(createInfrastructureParser());

  // Generic fallback parser (priority 10)
  registry.register(createGenericParser());

  // Initialize noise checker for optimized noise filtering
  registry.initNoiseChecker();

  return registry;
};

// ============================================================================
// Convenience API for Simple Usage
// ============================================================================

/**
 * SINGLETON CONTEXT PARSERS - SINGLE-THREADED USE ONLY
 *
 * The singleton parsers (githubParser, actParser, passthroughParser) maintain
 * internal state between calls. They are designed for single-threaded use
 * in a single parsing session.
 *
 * WARNING: Do NOT use these singletons concurrently (e.g., in parallel async
 * operations or worker threads). State corruption will occur if multiple
 * parsing sessions share these singletons simultaneously.
 *
 * Usage pattern:
 *   1. Parse a complete log file using parse(), parseActLogs(), or parseGitHubLogs()
 *   2. Call resetDefaultExtractor() before parsing a new, unrelated log
 *
 * For concurrent parsing, create dedicated instances using factory functions:
 *   const parser = createActParser();
 *   const extractor = createExtractor(createDefaultRegistry());
 *   extractor.extract(logs, parser);
 */
import { actParser, githubParser, passthroughParser } from "./context/index.js";
import { createExtractor, type Extractor } from "./extractor.js";
import type { ExtractedError } from "./types.js";

/**
 * Singleton registry with all default parsers.
 * Created lazily on first use.
 */
let defaultRegistry: ParserRegistry | undefined;

/**
 * Singleton extractor with default registry.
 * Created lazily on first use.
 */
let defaultExtractor: Extractor | undefined;

/**
 * Track concurrent extraction attempts to detect misuse.
 * SECURITY: Uses a counter (not boolean) to detect overlapping async calls.
 * If count > 1, multiple extractions are running concurrently on singletons.
 * Using object wrapper to allow mutation while satisfying linter const rule.
 */
const extractionState = { count: 0 };

/**
 * Get the default registry (creates it on first call).
 * Uses all parsers and noise checker initialized.
 *
 * Use this for tool detection when you don't need full extraction.
 * The registry is cached to avoid repeated instantiation overhead.
 */
export const getDefaultRegistry = (): ParserRegistry => {
  if (!defaultRegistry) {
    defaultRegistry = createDefaultRegistry();
  }
  return defaultRegistry;
};

/**
 * Get the default extractor (creates it on first call).
 * Uses the default registry with all parsers and noise checker initialized.
 */
export const getDefaultExtractor = (): Extractor => {
  if (!defaultExtractor) {
    defaultExtractor = createExtractor(getDefaultRegistry());
  }
  return defaultExtractor;
};

/**
 * Internal wrapper to track extraction state for misuse detection.
 * SECURITY: Uses counter to detect concurrent singleton usage.
 */
const extractWithTracking = (
  logs: string,
  ctxParser: Parameters<Extractor["extract"]>[1]
): ExtractedError[] => {
  extractionState.count++;
  if (extractionState.count > 1) {
    console.warn(
      `[parser] Concurrent singleton usage detected (${extractionState.count} active extractions). ` +
        "This will cause state corruption. For concurrent parsing, create dedicated instances:\n" +
        "  const parser = createActParser();\n" +
        "  const extractor = createExtractor(createDefaultRegistry());\n" +
        "  extractor.extract(logs, parser);\n" +
        "See: https://github.com/detent-sh/detent/tree/main/packages/parser#concurrent-parsing"
    );
  }
  try {
    return getDefaultExtractor().extract(logs, ctxParser);
  } finally {
    extractionState.count--;
  }
};

/**
 * Parse logs using the default extractor and passthrough context parser.
 * This is the simplest way to extract errors from raw log output.
 *
 * @example
 * ```typescript
 * import { parse } from "@detent/parser";
 *
 * const errors = parse(logOutput);
 * console.log(errors); // ExtractedError[]
 * ```
 */
export const parse = (logs: string): ExtractedError[] =>
  extractWithTracking(logs, passthroughParser);

/**
 * Parse logs from Act (local GitHub Actions runner) format.
 * Strips [Job/Step] prefixes and extracts job/step context.
 *
 * @example
 * ```typescript
 * import { parseActLogs } from "@detent/parser";
 *
 * const errors = parseActLogs(actOutput);
 * console.log(errors); // ExtractedError[] with workflowContext
 * ```
 */
export const parseActLogs = (logs: string): ExtractedError[] =>
  extractWithTracking(logs, actParser);

/**
 * Parse logs from GitHub Actions format.
 * Strips ISO timestamps and extracts errors.
 *
 * @example
 * ```typescript
 * import { parseGitHubLogs } from "@detent/parser";
 *
 * const errors = parseGitHubLogs(githubLogs);
 * console.log(errors); // ExtractedError[]
 * ```
 */
export const parseGitHubLogs = (logs: string): ExtractedError[] =>
  extractWithTracking(logs, githubParser);

/**
 * Reset the default extractor and all singleton context parsers.
 * Call this between parsing unrelated log outputs to clear any accumulated state.
 *
 * This resets:
 * - The default extractor's workflow context
 * - All registered tool parsers
 * - The singleton GitHub parser's step tracking state
 * - The singleton Act parser (no-op, included for consistency)
 *
 * WARNING: This function should only be called between parsing sessions,
 * never during an active extraction. The singletons are designed for
 * single-threaded, sequential use only.
 */
export const resetDefaultExtractor = (): void => {
  // SECURITY: Detect misuse - resetting during active extraction causes corruption
  if (extractionState.count > 0) {
    console.warn(
      `[parser] resetDefaultExtractor() called while ${extractionState.count} extraction(s) in progress. ` +
        "This may cause state corruption. For concurrent parsing, use factory functions: " +
        "createActParser(), createGitHubContextParser(), createExtractor()."
    );
  }

  defaultExtractor?.reset();
  // Reset all singleton context parsers to ensure clean state
  githubParser.reset();
  actParser.reset();
  // passthroughParser is stateless, reset() is a no-op
};
