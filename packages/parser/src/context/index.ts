/**
 * CI context parsers.
 * Handle CI-specific log FORMAT (prefixes, timestamps, noise filtering).
 */

// Types - re-exported from @detent/types for API convenience
export type {
  CIProvider,
  CIProviderID,
  CIProviderOptions,
  ContextParser,
  LineContext,
  ParseLineResult,
} from "@detent/types";

// Parsers
export { actParser, createActParser } from "./act.js";
export { createGitHubContextParser, githubParser } from "./github.js";
export {
  createGitLabContextParser,
  gitlabParser,
  gitlabProvider,
} from "./gitlab.js";
export { createPassthroughParser, passthroughParser } from "./passthrough.js";

// Provider abstraction
export {
  actProvider,
  addCIProvider,
  addCIProviders,
  createCIProvider,
  detectCIProvider,
  getAllProviders,
  getCIProviderName,
  getCIProviders,
  getProviderByID,
  githubProvider,
  invalidateCIProviderCache,
  isCI,
  passthroughProvider,
  removeCIProvider,
  resetCIProviders,
} from "./provider.js";
