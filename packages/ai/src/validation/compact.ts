/**
 * Common Unicode homoglyphs that can bypass ASCII-only pattern matching.
 * Maps confusable characters to their ASCII equivalents.
 * Covers Cyrillic, Greek, and other common lookalikes.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic lookalikes
  а: "a",
  е: "e",
  і: "i",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  А: "A",
  В: "B",
  С: "C",
  Е: "E",
  Н: "H",
  І: "I",
  К: "K",
  М: "M",
  О: "O",
  Р: "P",
  Т: "T",
  Х: "X",
  // Greek lookalikes
  Α: "A",
  Β: "B",
  Ε: "E",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Χ: "X",
  Υ: "Y",
  Ζ: "Z",
  ο: "o",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  // Fullwidth variants
  "＜": "<",
  "＞": ">",
  "／": "/",
  // Other confusables
  ǀ: "|",
  ı: "i",
  ȷ: "j",
  ｉ: "i",
  ｏ: "o",
  ɑ: "a",
  ɡ: "g",
  ɴ: "N",
  ʀ: "R",
  ʏ: "Y",
  ꓱ: "E",
  ꓲ: "I",
  ꓳ: "O",
  // Mathematical alphanumerics (sometimes used in obfuscation)
  𝐚: "a",
  𝐛: "b",
  𝐜: "c",
  𝐝: "d",
  𝐞: "e",
  𝐟: "f",
  𝐠: "g",
  𝐡: "h",
  𝐢: "i",
  𝐣: "j",
  𝐤: "k",
  𝐥: "l",
  𝐦: "m",
  𝐧: "n",
  𝐨: "o",
  𝐩: "p",
  𝐪: "q",
  𝐫: "r",
  𝐬: "s",
  𝐭: "t",
  𝐮: "u",
  𝐯: "v",
  𝐰: "w",
  𝐱: "x",
  𝐲: "y",
  𝐳: "z",
};

/**
 * Normalizes Unicode text to ASCII equivalents for pattern matching.
 * Uses NFKD normalization + homoglyph replacement to defeat bypass attempts.
 */
const normalizeToAscii = (text: string): string => {
  // First apply NFKD normalization and strip combining marks
  const normalized = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  // Then replace known homoglyphs that NFKD doesn't handle
  let result = "";
  for (const char of normalized) {
    result += HOMOGLYPH_MAP[char] ?? char;
  }
  return result;
};

/**
 * Characters that could be used for prompt injection attacks.
 * These are sanitized to prevent malicious CI output from manipulating the LLM.
 */
const PROMPT_INJECTION_PATTERNS = [
  // XML/HTML-like tags that could close our <ci_output> block or inject roles
  /<\/?ci_output>/gi,
  /<\/?system>/gi,
  /<\/?user>/gi,
  /<\/?assistant>/gi,
  /<\/?human>/gi,
  /<\/?instructions>/gi,
  // Anthropic-style message separators
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<<SYS>>/gi,
  /<\/SYS>>/gi,
  // Common prompt injection phrases
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /ignore\s+(all\s+)?prior\s+instructions/gi,
  /disregard\s+(all\s+)?previous/gi,
  /forget\s+(all\s+)?previous/gi,
  /new\s+instructions?\s*:/gi,
  /system\s*prompt\s*:/gi,
  /you\s+are\s+now\s+/gi,
  /act\s+as\s+if\s+/gi,
  /pretend\s+(?:you\s+are|to\s+be)\s+/gi,
  /override\s+(?:your\s+)?(?:instructions|rules)/gi,
];

/**
 * Sanitizes content to prevent prompt injection attacks.
 * Removes or neutralizes patterns that could manipulate the LLM.
 * Normalizes Unicode to ASCII first to prevent homoglyph bypasses.
 */
export const sanitizeForPrompt = (content: string): string => {
  // Normalize Unicode to ASCII to catch homoglyph bypass attempts
  let result = normalizeToAscii(content);
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    result = result.replace(pattern, "[FILTERED]");
  }
  return result;
};

// Combined noise pattern - single regex for O(1) matching per line
// Matches: empty lines, separators, passing/pending counts, npm/yarn notices,
// internal stack frames, download/install/resolve progress, caret/tilde lines
const NOISE_PATTERN =
  /^(?:\s*$|[-=]{3,}$|\s*\d+\s+(?:passing|pending)\b|(?:npm|yarn)\s+(?:warn|notice)\b|\s*at\s+(?:Object\.|Module\.|Function\.|node:|internal\/)|(?:Downloading|Installing|Resolving)\b|\s*[\^~]+\s*$)/i;

// Combined important pattern - single regex for O(1) matching per line
// Matches: error/warning keywords, file locations, line references, code context, test results
const IMPORTANT_PATTERN =
  /error|warning|failed|failure|exception|:\d+:\d+|line\s+\d+|^\s*>\s+\d+\s*\||FAIL|PASS|ERROR|WARN/i;

// Early cutoff multiplier: process at most 3x the final target to avoid
// wasting CPU on content that will be truncated. With ~50% noise removal,
// 3x gives good margin for compaction to work effectively.
const EARLY_CUTOFF_MULTIPLIER = 3;

/**
 * Compacts CI output by removing noise while preserving errors.
 *
 * Filters:
 * - Empty lines and separators
 * - npm/yarn notices
 * - Internal stack frames (node:, internal/, etc.)
 * - Download/install progress
 *
 * Preserves:
 * - Lines with error/warning/failed
 * - File locations (file.ts:42:5)
 * - Code context lines
 * - Test results (FAIL, PASS)
 *
 * @param content - Raw CI output
 * @param targetLength - Target length after compaction (for early cutoff optimization)
 */
export const compactCiOutput = (
  content: string,
  targetLength = 15_000
): string => {
  // Early cutoff: don't process content far beyond what we'll keep
  const earlyCutoff = targetLength * EARLY_CUTOFF_MULTIPLIER;
  const truncatedEarly = content.length > earlyCutoff;
  const toProcess = truncatedEarly ? content.slice(0, earlyCutoff) : content;

  const lines = toProcess.split("\n");
  const result: string[] = [];
  let consecutiveNoiseCount = 0;

  for (const line of lines) {
    const isNoise = NOISE_PATTERN.test(line);
    const isImportant = IMPORTANT_PATTERN.test(line);

    if (isImportant || !isNoise) {
      if (consecutiveNoiseCount > 3) {
        result.push(`... [${consecutiveNoiseCount} lines omitted]`);
      }
      consecutiveNoiseCount = 0;
      result.push(line);
    } else {
      consecutiveNoiseCount++;
    }
  }

  if (consecutiveNoiseCount > 3) {
    result.push(`... [${consecutiveNoiseCount} lines omitted]`);
  }

  if (truncatedEarly) {
    result.push(
      `... [early cutoff applied, ${content.length - earlyCutoff} more characters not processed]`
    );
  }

  return result.join("\n");
};

/**
 * Truncates content for the prompt to avoid excessive token usage.
 */
export const truncateContent = (
  content: string,
  maxLength = 15_000
): string => {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n... [truncated, ${content.length - maxLength} more characters]`;
};

/**
 * Prepares CI output for LLM processing with compaction, sanitization, and truncation.
 * Applies all security measures to prevent prompt injection and reduce costs.
 */
export const prepareForPrompt = (content: string, maxLength = 15_000): string =>
  truncateContent(
    sanitizeForPrompt(compactCiOutput(content, maxLength)),
    maxLength
  );
