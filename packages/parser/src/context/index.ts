/**
 * CI context parsers.
 * Handle CI-specific log FORMAT (prefixes, timestamps, noise filtering).
 */

// Types - re-exported from @detent/types for API convenience
export type {
  ContextParser,
  LineContext,
  ParseLineResult,
} from "@detent/types";
// Parsers
export { actParser, createActParser } from "./act.js";
export { createGitHubContextParser, githubParser } from "./github.js";
export { createPassthroughParser, passthroughParser } from "./passthrough.js";
