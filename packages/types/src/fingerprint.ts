/**
 * Hierarchical fingerprints for issue diagnostics (dedupe and clustering).
 */
export interface IssueFingerprints {
  /**
   * Cross-repo key. Based on: source:ruleId:normalizedPattern
   */
  readonly lore: string;

  /**
   * Per-repo key. Based on lore + normalized file path.
   */
  readonly repo: string;

  /**
   * Instance key for exact dedupe. Based on repo + line + column.
   */
  readonly instance: string;

  /**
   * Normalized message pattern used for fingerprinting.
   */
  readonly normalizedPattern: string;
}
