export interface AutofixConfig {
  source: string;
  command: string;
  installCommand?: string;
  priority: number;
}

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
    command: "",
    priority: 0,
  },
};

export const getAutofixConfig = (source: string): AutofixConfig | undefined =>
  AUTOFIX_REGISTRY[source.toLowerCase()];

export const hasAutofix = (source: string): boolean => {
  const config = getAutofixConfig(source);
  return config !== undefined && config.command !== "";
};

export const getAutofixesForSources = (sources: string[]): AutofixConfig[] => {
  const uniqueSources = [...new Set(sources.map((s) => s.toLowerCase()))];
  return uniqueSources
    .map(getAutofixConfig)
    .filter((c): c is AutofixConfig => c !== undefined && c.command !== "")
    .sort((a, b) => b.priority - a.priority);
};
