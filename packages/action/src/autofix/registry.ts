/**
 * Autofix command registry for the GitHub Action.
 *
 * NOTE: This registry is intentionally duplicated in apps/api/src/services/autofix/registry.ts.
 * The API registry is used by the orchestrator to create heal records with the command,
 * while this action registry includes a security allowlist for command validation.
 * Both registries must be kept in sync when adding new autofix sources.
 *
 * TODO: Consider extracting to a shared package when the monorepo supports it.
 */

export interface AutofixConfig {
  source: string; // Error source (e.g., "biome", "eslint")
  command: string; // Command to run (e.g., "biome check --write .")
  installCommand?: string; // Optional install command
  priority: number; // Higher = run first
}

// Allowlist of commands that can be executed for security validation
export const COMMAND_ALLOWLIST = [
  "biome check --write .",
  "eslint --fix .",
  "prettier --write .",
  "cargo clippy --fix --allow-dirty --allow-staged",
  "golangci-lint run --fix",
  "bun run fix",
  "npm run fix",
] as const;

// Registry of known autofix commands
export const AUTOFIX_REGISTRY: Record<string, AutofixConfig> = {
  biome: {
    source: "biome",
    command: "biome check --write .",
    priority: 100,
  },
  eslint: {
    source: "eslint",
    command: "eslint --fix .",
    priority: 90,
  },
  prettier: {
    source: "prettier",
    command: "prettier --write .",
    priority: 80,
  },
  cargo: {
    source: "cargo",
    command: "cargo clippy --fix --allow-dirty --allow-staged",
    priority: 70,
  },
  golangci: {
    source: "golangci",
    command: "golangci-lint run --fix",
    priority: 70,
  },
  "bun-fix": {
    source: "bun-fix",
    command: "bun run fix",
    priority: 60,
  },
  "npm-fix": {
    source: "npm-fix",
    command: "npm run fix",
    priority: 50,
  },
  typescript: {
    source: "typescript",
    command: "", // No autofix, but could add tsc suggestions
    priority: 0,
  },
};

// Check if a command is in the allowlist
export const isCommandAllowed = (command: string): boolean => {
  return (COMMAND_ALLOWLIST as readonly string[]).includes(command);
};

// Get autofix config for a source
export const getAutofixConfig = (source: string): AutofixConfig | undefined => {
  return AUTOFIX_REGISTRY[source.toLowerCase()];
};

// Check if source has autofix available
export const hasAutofix = (source: string): boolean => {
  const config = getAutofixConfig(source);
  return config !== undefined && config.command !== "";
};

// Get all autofix configs for a list of sources, sorted by priority
export const getAutofixesForSources = (sources: string[]): AutofixConfig[] => {
  const uniqueSources = [...new Set(sources.map((s) => s.toLowerCase()))];
  return uniqueSources
    .map(getAutofixConfig)
    .filter((c): c is AutofixConfig => c !== undefined && c.command !== "")
    .sort((a, b) => b.priority - a.priority);
};
