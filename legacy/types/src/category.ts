/**
 * ErrorCategory represents the type of error for categorization and AI prompt generation.
 */
export type ErrorCategory =
  | "lint"
  | "type-check"
  | "test"
  | "compile"
  | "runtime"
  | "metadata"
  | "security"
  | "dependency"
  | "config"
  | "infrastructure"
  | "docs"
  | "unknown";

/**
 * All defined error categories.
 */
export const AllCategories: readonly ErrorCategory[] = [
  "lint",
  "type-check",
  "test",
  "compile",
  "runtime",
  "metadata",
  "security",
  "dependency",
  "config",
  "infrastructure",
  "docs",
  "unknown",
] as const;

/**
 * Check if a string is a valid error category.
 */
export const isValidCategory = (cat: string): cat is ErrorCategory =>
  AllCategories.includes(cat as ErrorCategory);
