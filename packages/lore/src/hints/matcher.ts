import type { HintableError, HintMatch, HintRule } from "../types.js";
import { HINT_RULES } from "./rules.js";

/**
 * Maximum message length to match against regex patterns.
 * Prevents ReDoS attacks on extremely long error messages.
 */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Safely tests a regex against a message with length limiting.
 * Returns false if message exceeds MAX_MESSAGE_LENGTH to prevent ReDoS.
 */
const safeRegexTest = (pattern: RegExp, message: string): boolean => {
  if (message.length > MAX_MESSAGE_LENGTH) {
    return false;
  }
  return pattern.test(message);
};

/**
 * Index rules by source for O(1) lookup.
 */
const indexRulesBySource = (rules: HintRule[]): Map<string, HintRule[]> => {
  const indexed = new Map<string, HintRule[]>();
  for (const rule of rules) {
    const existing = indexed.get(rule.source) ?? [];
    existing.push(rule);
    indexed.set(rule.source, existing);
  }
  return indexed;
};

// Pre-index built-in rules
const RULES_BY_SOURCE = indexRulesBySource(HINT_RULES);

const formatHint = (rule: HintRule): string => {
  let hint = rule.hint;
  if (rule.docUrl) {
    hint += ` Docs: ${rule.docUrl}`;
  }
  if (rule.fixPattern) {
    hint += ` Fix: ${rule.fixPattern}`;
  }
  return hint;
};

/**
 * Match rules against an error and collect hints.
 */
const collectHintsFromRules = (
  rules: HintRule[] | undefined,
  error: HintableError,
  hints: string[]
): void => {
  if (!rules) {
    return;
  }
  for (const rule of rules) {
    if (rule.ruleId && rule.ruleId === error.ruleId) {
      hints.push(formatHint(rule));
      continue;
    }
    if (
      rule.messagePattern &&
      safeRegexTest(rule.messagePattern, error.message)
    ) {
      hints.push(formatHint(rule));
    }
  }
};

export const matchHints = <T extends HintableError>(
  errors: T[]
): HintMatch<T>[] =>
  errors.map((error) => {
    const hints: string[] = [];
    const sourceRules = error.source
      ? RULES_BY_SOURCE.get(error.source)
      : undefined;
    collectHintsFromRules(sourceRules, error, hints);
    return { error, hints };
  });

export const getHintsForError = <T extends HintableError>(
  error: T
): string[] => {
  const [match] = matchHints([error]);
  return match?.hints ?? [];
};

/**
 * Create a custom hint matcher with additional rules.
 * Custom rules are checked first, then built-in rules.
 */
export const createHintMatcher = (
  customRules: HintRule[]
): {
  matchHints: <T extends HintableError>(errors: T[]) => HintMatch<T>[];
  getHintsForError: <T extends HintableError>(error: T) => string[];
} => {
  const customRulesBySource = indexRulesBySource(customRules);

  const matchHintsCustom = <T extends HintableError>(
    errors: T[]
  ): HintMatch<T>[] =>
    errors.map((error) => {
      const hints: string[] = [];
      const source = error.source;

      if (source) {
        collectHintsFromRules(customRulesBySource.get(source), error, hints);
        collectHintsFromRules(RULES_BY_SOURCE.get(source), error, hints);
      }

      return { error, hints };
    });

  const getHintsForErrorCustom = <T extends HintableError>(
    error: T
  ): string[] => {
    const [match] = matchHintsCustom([error]);
    return match?.hints ?? [];
  };

  return {
    matchHints: matchHintsCustom,
    getHintsForError: getHintsForErrorCustom,
  };
};
