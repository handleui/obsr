/**
 * GitHub Actions log context parser.
 * Parses logs from GitHub Actions runners (fetched via GitHub API).
 *
 * GitHub Actions log format:
 * - Lines are prefixed with timestamps: 2024-01-15T10:30:45.1234567Z message
 * - Step markers: ##[group]Run <step-name> / ##[endgroup]
 * - Workflow commands: ::error file=x,line=1::message, ::warning::, ::notice::
 * - User groups: ::group::title / ::endgroup::
 * - Debug output: ::debug::message
 *
 * This parser:
 * - Strips timestamps from all lines
 * - Tracks current step from ##[group] markers
 * - Filters noise (debug, user groups) while preserving step context
 */

import type { ContextParser, ParseLineResult } from "./types.js";

/**
 * Maximum step name length to prevent memory exhaustion from malicious input.
 * Step names longer than this are truncated with a "[TRUNCATED]" suffix.
 *
 * 256 was chosen because:
 * - Aligns with common filesystem path component limits (255 on most systems)
 * - Power of 2 (2^8), efficient for memory allocation
 * - Generous for legitimate step names (typical are 20-80 chars)
 * - Standard limit in many logging/monitoring systems
 */
const MAX_STEP_NAME_LENGTH = 256;

/**
 * Regex to match GitHub Actions timestamp prefix.
 * Format: 2024-01-15T10:30:45.1234567Z (ISO 8601 with nanosecond precision)
 * The timestamp is always at the start of the line followed by a space.
 *
 * SECURITY: Quantifiers are bounded to prevent ReDoS:
 * - Nanoseconds: 1-9 digits (GitHub uses 7, we allow flexibility)
 * - Trailing whitespace: 0-10 spaces (normal is 1)
 */
const TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z\s{0,10}/;

/**
 * Regex to match step group start marker.
 * Format: ##[group]Run npm run lint OR ##[group]Set up job
 */
const STEP_GROUP_START = /^##\[group\](.+)$/;

/**
 * Regex to match step group end marker.
 */
const STEP_GROUP_END = /^##\[endgroup\]/;

/**
 * Combined regex to parse step markers more efficiently.
 * Matches: "Run <action>", "Post <action>", or plain "<step>"
 * Groups:
 *   1: "Run " or "Post " prefix (optional)
 *   2: Step/action content
 *
 * Examples:
 *   "Run npm run lint" -> ["Run ", "npm run lint"]
 *   "Run actions/checkout@v4" -> ["Run ", "actions/checkout@v4"]
 *   "Post actions/checkout@v4" -> ["Post ", "actions/checkout@v4"]
 *   "Set up job" -> [undefined, "Set up job"]
 */
const STEP_PARSE_REGEX = /^(?:(Run\s+|Post\s+))?(.+)$/;

/**
 * Regex to extract action name from action path.
 * Matches: "org/action-name@version" or "org/sub/action-name@version"
 * Groups:
 *   1: Action name (last path segment before @)
 *
 * Examples:
 *   "actions/checkout@v4" -> "checkout"
 *   "google-github-actions/auth@v2" -> "auth"
 *   "actions/cache@main" -> "cache"
 */
const ACTION_NAME_REGEX = /\/([^/@]+)@/;

/**
 * Fast prefix checks for noise detection.
 * Note: "##[" is NOT included - we handle ##[group] and ##[endgroup] explicitly.
 * Ordered by expected frequency for faster early exit.
 */
const FAST_NOISE_PREFIXES: readonly string[] = [
  "::debug::",
  "::group::",
  "::endgroup::",
];

/**
 * Combined regex for noise patterns that can't be detected with simple prefix checks.
 * Uses alternation with non-capturing groups for efficiency.
 *
 * Matches:
 * - Empty/whitespace-only lines: /^\s*$/
 * - GitHub Actions internal markers EXCEPT group/endgroup: /^##\[(?!group\]|endgroup\])/
 */
const NOISE_REGEX = /^(?:\s*$|##\[(?!group\]|endgroup\]))/;

/**
 * Truncate a step name if it exceeds the maximum length.
 * SECURITY: Prevents memory exhaustion from maliciously long step names.
 *
 * @param name - The step name to potentially truncate
 * @returns The original name if within limit, or truncated with suffix
 */
const truncateStepName = (name: string): string => {
  if (name.length <= MAX_STEP_NAME_LENGTH) {
    return name;
  }
  // Leave room for the suffix
  const truncatedLength = MAX_STEP_NAME_LENGTH - 12; // "[TRUNCATED]" is 11 chars + space
  return `${name.slice(0, truncatedLength)} [TRUNCATED]`;
};

/**
 * Check if a cleaned line is noise that should be skipped.
 * Note: This does NOT check for ##[group] or ##[endgroup] - those are handled
 * explicitly in parseLine for step tracking.
 *
 * Optimized to:
 * 1. Check fast string prefixes first (most common noise types)
 * 2. Use a single combined regex for remaining patterns
 */
const isNoiseLine = (cleanedLine: string): boolean => {
  const trimmed = cleanedLine.trim();

  // Fast path: check common prefixes with simple string operations
  // These are more common than the regex-only patterns
  for (const prefix of FAST_NOISE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return true;
    }
  }

  // Regex check for patterns that need regex: empty lines and ##[...] markers
  return NOISE_REGEX.test(trimmed);
};

/**
 * GitHubParser extracts context from GitHub Actions log output format.
 * GitHub Actions prefixes each line with an ISO 8601 timestamp.
 *
 * This parser is STATEFUL - it tracks the current step from ##[group] markers
 * and applies that context to subsequent lines until a new step starts.
 */
class GitHubParser implements ContextParser {
  /** Current step name (e.g., "npm run lint" or "checkout") */
  private currentStep = "";
  /** Current action name for GitHub Actions (e.g., "actions/checkout@v4") */
  private currentAction = "";

  /**
   * Parse a line of GitHub Actions output and extract context.
   *
   * @param line - Raw line from GitHub Actions log
   * @returns ParseLineResult with cleaned line (timestamp stripped) and step context
   */
  parseLine = (line: string): ParseLineResult => {
    // Strip timestamp prefix if present
    const cleanLine = line.replace(TIMESTAMP_REGEX, "");
    const trimmed = cleanLine.trim();

    // Handle step group START marker - extract step name
    const groupMatch = STEP_GROUP_START.exec(trimmed);
    if (groupMatch?.[1]) {
      this.updateStepContext(groupMatch[1].trim());
      return {
        ctx: {
          job: "",
          step: this.currentStep,
          action: this.currentAction || undefined,
          isNoise: true,
        },
        cleanLine,
        skip: true, // Skip the marker line itself, but we've captured the step
      };
    }

    // Handle step group END marker - preserve context for any following errors
    if (STEP_GROUP_END.test(trimmed)) {
      return {
        ctx: {
          job: "",
          step: this.currentStep,
          action: this.currentAction || undefined,
          isNoise: true,
        },
        cleanLine,
        skip: true,
      };
    }

    // Standard noise check for other patterns
    const isNoise = isNoiseLine(cleanLine);

    return {
      ctx: {
        job: "",
        step: this.currentStep,
        action: this.currentAction || undefined,
        isNoise,
      },
      cleanLine,
      skip: isNoise,
    };
  };

  /**
   * Update step context from a ##[group] marker content.
   *
   * Examples:
   * - "Run npm run lint" → step="npm run lint", action=undefined
   * - "Run actions/checkout@v4" → step="checkout", action="actions/checkout@v4"
   * - "Post actions/checkout@v4" → step="Post checkout", action="actions/checkout@v4"
   * - "Set up job" → step="Set up job", action=undefined
   *
   * Optimized to use a single regex parse instead of multiple replace/split operations.
   */
  private updateStepContext(rawStep: string): void {
    // Parse with single regex: captures prefix and content in one pass
    const match = STEP_PARSE_REGEX.exec(rawStep);
    const content = match?.[2];
    if (!content) {
      // Fallback for unexpected format (shouldn't happen with .+ in regex)
      this.currentStep = truncateStepName(rawStep);
      this.currentAction = "";
      return;
    }

    const prefix = match[1]; // "Run " or "Post " or undefined

    // Check if this is a GitHub Action (contains @ for version)
    const actionMatch = ACTION_NAME_REGEX.exec(content);
    const actionName = actionMatch?.[1];
    if (actionName) {
      // GitHub Action step: extract action name from path
      // For "Post " prefix on actions, the content already excludes "Run " but may include "Post "
      // e.g., rawStep="Post actions/checkout@v4" -> prefix="Post ", content="actions/checkout@v4"
      const isPost = prefix?.startsWith("Post") ?? false;

      // If prefix was "Run ", content is the action. If prefix was "Post ", content is the action.
      this.currentAction = truncateStepName(content);
      this.currentStep = truncateStepName(
        isPost ? `Post ${actionName}` : actionName
      );
    } else {
      // Shell command or built-in step (no @ in content)
      this.currentAction = "";
      this.currentStep = truncateStepName(content);
    }
  }

  /**
   * Reset parser state. Call between parsing unrelated log outputs
   * (e.g., between different job files from a ZIP archive).
   */
  reset = (): void => {
    this.currentStep = "";
    this.currentAction = "";
  };
}

/**
 * Create a new GitHub Actions context parser instance.
 * Use this factory for:
 * - Concurrent parsing operations (each needs its own instance)
 * - Testing isolation (fresh state per test)
 * - Parsing multiple unrelated log files
 */
export const createGitHubContextParser = (): ContextParser =>
  new GitHubParser();

/**
 * Singleton instance for convenience in sequential, single-threaded usage.
 *
 * WARNING: This parser is STATEFUL - it tracks the current step from ##[group] markers.
 * - Call reset() between parsing unrelated outputs
 * - Do NOT use for concurrent parsing - use createGitHubContextParser() instead
 * - Each independent parse operation should either reset() first or use a fresh instance
 */
export const githubParser: ContextParser = createGitHubContextParser();
