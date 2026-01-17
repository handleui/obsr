/**
 * CI context parser types.
 * Context parsers handle CI-specific log FORMAT (prefixes, timestamps).
 * They extract job/step context and clean lines for tool parsers.
 */

/**
 * LineContext contains CI platform-specific context extracted from a log line.
 */
export interface LineContext {
  /** Job name from CI output */
  readonly job: string;
  /** Step name (if parseable) */
  readonly step: string;
  /** Action name for GitHub Actions steps (e.g., "actions/checkout@v4") */
  readonly action?: string;
  /** True if line should be skipped (debug output) */
  readonly isNoise: boolean;
}

/**
 * Result of parsing a CI log line.
 */
export interface ParseLineResult {
  /** Extracted context */
  readonly ctx: LineContext;
  /** Cleaned line (with CI prefixes removed) */
  readonly cleanLine: string;
  /** Whether to skip this line entirely */
  readonly skip: boolean;
}

/**
 * ContextParser extracts CI platform-specific context from log lines.
 * Different CI systems (act, GitHub Actions, GitLab) implement this interface
 * to parse their specific output formats and extract job/step context.
 *
 * IMPORTANT: Parsers may be STATEFUL (e.g., GitHub Actions step tracking).
 * - Call reset() between parsing unrelated log outputs to clear state
 * - Do NOT share parser instances between concurrent parsing operations
 * - For concurrent parsing, use factory functions (createGitHubContextParser, etc.)
 *
 * @example
 * ```typescript
 * // Act format: [Job Name/Step Name] actual log content
 * const result = actParser.parseLine("[Build/Test] error: failed");
 * // { ctx: { job: "Build", step: "Test" }, cleanLine: "error: failed", skip: false }
 *
 * // GitHub format: 2024-01-15T10:30:45.1234567Z actual log content
 * const result = githubParser.parseLine("2024-01-15T10:30:45.1234567Z error: failed");
 * // { ctx: { job: "", step: "" }, cleanLine: "error: failed", skip: false }
 * ```
 */
export interface ContextParser {
  /**
   * Extracts context from a CI log line.
   * Returns the context, the cleaned line (with CI prefixes removed), and whether to skip.
   * If skip is true, the line should be ignored (debug noise, metadata).
   */
  parseLine(line: string): ParseLineResult;

  /**
   * Reset parser state to initial values.
   * Call between parsing unrelated log outputs to clear accumulated context.
   * Stateless parsers implement this as a no-op.
   */
  reset(): void;
}

// ============================================================================
// CI Provider Abstraction
// ============================================================================

/**
 * CI provider identifiers.
 * Used to identify which CI platform generated the logs.
 */
export type CIProviderID =
  | "github"
  | "act"
  | "gitlab"
  | "circleci"
  | "jenkins"
  | "passthrough";

/**
 * CIProvider represents a CI platform that can be detected and parsed.
 * This abstraction allows auto-detection of CI providers and centralized
 * registration of new providers.
 *
 * @example
 * ```typescript
 * const provider = detectCIProvider();
 * const parser = provider.createContextParser();
 * const errors = extractor.extract(logs, parser);
 * ```
 */
export interface CIProvider {
  /** Unique identifier for this provider */
  readonly id: CIProviderID;

  /** Human-readable name for display */
  readonly name: string;

  /**
   * Detect if running in this CI environment from environment variables.
   * Returns true if the environment indicates this CI provider.
   */
  detectFromEnv(): boolean;

  /**
   * Create a new context parser instance for this provider.
   * Use factory to create isolated instances for concurrent parsing.
   */
  createContextParser(): ContextParser;

  /**
   * Whether the context parser maintains state between lines.
   * Stateful parsers require reset() calls between unrelated logs.
   */
  readonly isStateful: boolean;

  /**
   * Optional priority for provider ordering during detection.
   * Higher priority providers are checked first.
   * Default: 0. Passthrough should have lowest priority (-1000).
   */
  readonly priority?: number;

  /**
   * Optional description for documentation and debugging.
   */
  readonly description?: string;
}

/**
 * Options for creating a CI provider.
 * All required CIProvider fields except createContextParser factory.
 */
export interface CIProviderOptions {
  /** Unique identifier for this provider */
  readonly id: CIProviderID;
  /** Human-readable name for display */
  readonly name: string;
  /** Environment variable detection function */
  readonly detectFromEnv: () => boolean;
  /** Factory function to create context parsers */
  readonly createContextParser: () => ContextParser;
  /** Whether the context parser maintains state between lines */
  readonly isStateful: boolean;
  /** Optional priority for ordering (default: 0) */
  readonly priority?: number;
  /** Optional description */
  readonly description?: string;
}
