/**
 * Generate a commit message for an autofix heal.
 *
 * Format: "fix(autofix): Apply <source> <action>"
 * Examples:
 * - "fix(autofix): Apply biome formatting fixes"
 * - "fix(autofix): Apply eslint fixes"
 * - "fix(autofix): Apply prettier formatting"
 */
export const generateAutofixCommitMessage = (
  source: string | null,
  errorCount: number
): string => {
  const normalizedSource = source ?? "autofix";
  const sourceDescriptions: Record<string, string> = {
    biome: "biome formatting fixes",
    eslint: "eslint fixes",
    prettier: "prettier formatting",
  };

  const description =
    sourceDescriptions[normalizedSource.toLowerCase()] ||
    `${normalizedSource} fixes`;
  const countSuffix = errorCount > 1 ? ` (${errorCount} issues)` : "";

  return `fix(autofix): Apply ${description}${countSuffix}`;
};
