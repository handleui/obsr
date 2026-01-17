import { createActParser } from "./act.js";
import { createGitHubContextParser } from "./github.js";
import { gitlabProvider } from "./gitlab.js";
import { createPassthroughParser } from "./passthrough.js";
import type { CIProvider, CIProviderID, CIProviderOptions } from "./types.js";

// ============================================================================
// Security Constants
// ============================================================================

/**
 * Maximum length for provider ID strings to prevent memory exhaustion.
 */
const maxIDLength = 64;

/**
 * Maximum length for provider name strings to prevent memory exhaustion.
 */
const maxNameLength = 128;

/**
 * Dangerous property names that could enable prototype pollution attacks.
 * These must be rejected as provider IDs to prevent attackers from
 * registering providers with IDs like "__proto__" that could pollute
 * Object.prototype when used as object keys.
 */
const dangerousPropertyNames: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

// ============================================================================
// Priority Constants
// ============================================================================

/** Default priority for custom providers */
const DEFAULT_PROVIDER_PRIORITY = 0;

/** Passthrough provider priority (always checked last as fallback) */
const PASSTHROUGH_PRIORITY = -1000;

// ============================================================================
// Environment Access Helper
// ============================================================================

/**
 * Safely access an environment variable.
 * Returns undefined if process.env is not available (e.g., in Cloudflare Workers).
 *
 * NOTE: CI provider detection via environment variables only works in Node.js-like
 * environments. In Cloudflare Workers or browsers, detectFromEnv will return false.
 * For Workers, use explicit provider selection instead.
 */
const getEnvVar = (key: string): string | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return typeof process !== "undefined" ? process.env[key] : undefined;
  } catch {
    // process.env access may throw in some environments
    return undefined;
  }
};

// ============================================================================
// Built-in Providers
// ============================================================================

export const githubProvider: CIProvider = {
  id: "github",
  name: "GitHub Actions",
  isStateful: true,
  priority: 10,
  detectFromEnv: () => getEnvVar("GITHUB_ACTIONS") === "true",
  createContextParser: createGitHubContextParser,
};

export const actProvider: CIProvider = {
  id: "act",
  name: "Act (Local)",
  isStateful: false,
  priority: 20,
  description: "Local GitHub Actions runner (nektos/act)",
  detectFromEnv: () => getEnvVar("ACT") === "true",
  createContextParser: createActParser,
};

export const passthroughProvider: CIProvider = {
  id: "passthrough",
  name: "Raw Logs",
  isStateful: false,
  priority: PASSTHROUGH_PRIORITY,
  description: "Fallback provider for unrecognized CI environments",
  detectFromEnv: () => false,
  createContextParser: createPassthroughParser,
};

/**
 * Cached result for CI provider detection.
 * Invalidated when providers are added/removed or via invalidateCIProviderCache().
 */
let cachedDetectedProvider: CIProvider | undefined;

const builtInProviderIDs: ReadonlySet<CIProviderID> = new Set([
  "act",
  "github",
  "gitlab",
  "passthrough",
]);

const defaultProviders: readonly CIProvider[] = [
  actProvider,
  githubProvider,
  gitlabProvider,
  passthroughProvider,
];

const mutableProviders: CIProvider[] = [...defaultProviders];

const maxCustomProviders = 20;

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a CI provider from options.
 * Validates all required fields and applies defaults.
 *
 * @example
 * ```typescript
 * const myProvider = createCIProvider({
 *   id: "circleci",
 *   name: "CircleCI",
 *   detectFromEnv: () => process.env.CIRCLECI === "true",
 *   createContextParser: createMyParser,
 *   isStateful: false,
 * });
 * addCIProvider(myProvider);
 * ```
 */
export const createCIProvider = (options: CIProviderOptions): CIProvider => ({
  id: options.id,
  name: options.name,
  detectFromEnv: options.detectFromEnv,
  createContextParser: options.createContextParser,
  isStateful: options.isStateful,
  priority: options.priority ?? DEFAULT_PROVIDER_PRIORITY,
  description: options.description,
});

// ============================================================================
// Registry API
// ============================================================================

/**
 * Invalidate the cached CI provider detection result.
 * Called automatically when providers are added/removed.
 * Can be called manually if environment variables change at runtime.
 */
export const invalidateCIProviderCache = (): void => {
  cachedDetectedProvider = undefined;
};

/**
 * Sort providers by priority (highest first).
 * Called after adding/removing providers.
 */
const sortProvidersByPriority = (): void => {
  mutableProviders.sort((a, b) => {
    const priorityA = a.priority ?? DEFAULT_PROVIDER_PRIORITY;
    const priorityB = b.priority ?? DEFAULT_PROVIDER_PRIORITY;
    return priorityB - priorityA;
  });
};

/**
 * Add a CI provider to the registry.
 *
 * SECURITY: This function validates inputs to prevent:
 * - Memory exhaustion from unbounded provider registration
 * - String length attacks via excessively long IDs/names
 * - Prototype pollution via dangerous property names
 * - Empty/invalid provider data that could cause runtime errors
 *
 * @throws Error if provider limit exceeded or provider is invalid
 */
export const addCIProvider = (provider: CIProvider): void => {
  validateProvider(provider);

  if (mutableProviders.some((p) => p.id === provider.id)) {
    throw new Error(
      `addCIProvider: provider with id "${provider.id}" already exists`
    );
  }

  const customCount = mutableProviders.length - defaultProviders.length;
  if (customCount >= maxCustomProviders) {
    throw new Error(
      `addCIProvider: maximum of ${maxCustomProviders} custom providers exceeded`
    );
  }

  mutableProviders.push(provider);
  sortProvidersByPriority();
  invalidateCIProviderCache();
};

/**
 * Validate a provider without adding it to the registry.
 * Used by addCIProviders to ensure atomic operations.
 */
const validateProvider = (provider: CIProvider): void => {
  // SECURITY: Validate provider object structure
  if (!provider || typeof provider !== "object") {
    throw new Error("addCIProvider: provider must be a non-null object");
  }

  // SECURITY: Prevent arrays from being treated as valid objects
  if (Array.isArray(provider)) {
    throw new Error("addCIProvider: provider must be an object, not an array");
  }

  // SECURITY: Validate id with length limits
  if (typeof provider.id !== "string" || provider.id.length === 0) {
    throw new Error("addCIProvider: id must be a non-empty string");
  }
  if (provider.id.length > maxIDLength) {
    throw new Error(
      `addCIProvider: id must be at most ${maxIDLength} characters`
    );
  }
  if (dangerousPropertyNames.has(provider.id)) {
    throw new Error(
      `addCIProvider: id "${provider.id}" is reserved and cannot be used`
    );
  }
  if (typeof provider.name !== "string" || provider.name.length === 0) {
    throw new Error("addCIProvider: name must be a non-empty string");
  }
  if (provider.name.length > maxNameLength) {
    throw new Error(
      `addCIProvider: name must be at most ${maxNameLength} characters`
    );
  }
  if (typeof provider.isStateful !== "boolean") {
    throw new Error("addCIProvider: isStateful must be a boolean");
  }
  if (typeof provider.detectFromEnv !== "function") {
    throw new Error("addCIProvider: detectFromEnv must be a function");
  }
  if (typeof provider.createContextParser !== "function") {
    throw new Error("addCIProvider: createContextParser must be a function");
  }
  if (
    provider.priority !== undefined &&
    typeof provider.priority !== "number"
  ) {
    throw new Error("addCIProvider: priority must be a number if provided");
  }
};

/**
 * Add multiple CI providers at once (atomic operation).
 * Validates all providers before adding any, ensuring either all succeed or none are added.
 *
 * SECURITY: Each provider is validated before any are added.
 * @throws Error if any provider is invalid or limit would be exceeded
 */
export const addCIProviders = (providers: readonly CIProvider[]): void => {
  // Pre-validate all providers before adding any (atomic operation)
  for (const provider of providers) {
    validateProvider(provider);
    // Check for duplicates within the batch
    if (mutableProviders.some((p) => p.id === provider.id)) {
      throw new Error(
        `addCIProvider: provider with id "${provider.id}" already exists`
      );
    }
  }

  // Check if adding all would exceed the limit
  const customCount = mutableProviders.length - defaultProviders.length;
  if (customCount + providers.length > maxCustomProviders) {
    throw new Error(
      `addCIProvider: adding ${providers.length} providers would exceed maximum of ${maxCustomProviders} custom providers`
    );
  }

  // Check for duplicates within the batch itself
  const batchIds = new Set<string>();
  for (const provider of providers) {
    if (batchIds.has(provider.id)) {
      throw new Error(
        `addCIProvider: duplicate provider id "${provider.id}" in batch`
      );
    }
    batchIds.add(provider.id);
  }

  // All validation passed, now add all providers
  for (const provider of providers) {
    mutableProviders.push(provider);
  }
  sortProvidersByPriority();
  invalidateCIProviderCache();
};

export const removeCIProvider = (id: CIProviderID): boolean => {
  if (builtInProviderIDs.has(id)) {
    return false;
  }
  const index = mutableProviders.findIndex((p) => p.id === id);
  if (index === -1) {
    return false;
  }
  mutableProviders.splice(index, 1);
  // Invalidate cache when providers change
  invalidateCIProviderCache();
  return true;
};

/**
 * Get all CI providers (defensive copy).
 * SECURITY: Returns a shallow copy to prevent external mutation.
 *
 * PERFORMANCE NOTE: Creates a new array on each call. For hot paths that need
 * to iterate providers, consider using the internal iteration in detectCIProvider()
 * or getProviderByID() instead. This function is intended for introspection/debugging.
 */
export const getCIProviders = (): readonly CIProvider[] => [
  ...mutableProviders,
];

/**
 * Reset CI providers to defaults only.
 * Removes all custom providers added via addCIProvider().
 */
export const resetCIProviders = (): void => {
  mutableProviders.length = 0;
  mutableProviders.push(...defaultProviders);
  sortProvidersByPriority();
  invalidateCIProviderCache();
};

/**
 * Get a provider by ID using O(n) linear search.
 * For frequent lookups, consider caching the result.
 */
export const getProviderByID = (id: CIProviderID): CIProvider | undefined =>
  mutableProviders.find((p) => p.id === id);

/**
 * @deprecated Use getCIProviders() instead - this is an identical duplicate.
 * Alias kept for backward compatibility.
 */
export const getAllProviders = getCIProviders;

/**
 * Detect which CI provider is currently running based on environment variables.
 * Returns passthroughProvider if no CI environment is detected.
 *
 * PERFORMANCE: Result is cached after first call. Cache is invalidated when:
 * - Providers are added/removed/reset
 * - invalidateCIProviderCache() is called manually
 *
 * Call invalidateCIProviderCache() if environment variables change at runtime.
 */
export const detectCIProvider = (): CIProvider => {
  // Fast path: return cached result if available
  if (cachedDetectedProvider !== undefined) {
    return cachedDetectedProvider;
  }

  // Detect and cache
  for (const provider of mutableProviders) {
    if (provider.detectFromEnv()) {
      cachedDetectedProvider = provider;
      return provider;
    }
  }

  cachedDetectedProvider = passthroughProvider;
  return passthroughProvider;
};

/**
 * Check if running in a CI environment.
 * Uses cached detection result when available.
 *
 * NOTE: CI detection only works in Node.js-like environments.
 * In Cloudflare Workers or browsers, this will return false unless
 * a provider's detectFromEnv explicitly returns true.
 */
export const isCI = (): boolean => {
  // Fast path: check CI env var first (common across many CI systems)
  if (getEnvVar("CI") === "true") {
    return true;
  }
  // Leverage cached detection - avoids re-iterating providers
  return detectCIProvider().id !== "passthrough";
};

export const getCIProviderName = (): string => {
  const provider = detectCIProvider();
  return provider.id === "passthrough" ? "Local" : provider.name;
};
