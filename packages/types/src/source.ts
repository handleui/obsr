/**
 * Error sources for attribution and filtering.
 */
export type ErrorSource =
  | "biome"
  | "eslint"
  | "typescript"
  | "go"
  | "go-test"
  | "python"
  | "rust"
  | "vitest"
  | "docker"
  | "nodejs"
  | "metadata"
  | "infrastructure"
  | "generic";

/**
 * Named constants for error sources.
 */
export const ErrorSources = {
  Biome: "biome" as const,
  ESLint: "eslint" as const,
  TypeScript: "typescript" as const,
  Go: "go" as const,
  GoTest: "go-test" as const,
  Python: "python" as const,
  Rust: "rust" as const,
  Vitest: "vitest" as const,
  Docker: "docker" as const,
  NodeJS: "nodejs" as const,
  Metadata: "metadata" as const,
  Infrastructure: "infrastructure" as const,
  Generic: "generic" as const,
};
