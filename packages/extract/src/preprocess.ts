/**
 * Zero-width and invisible Unicode characters that could bypass pattern matching.
 * Removing these prevents attackers from hiding content or breaking up keywords.
 *
 * Includes:
 * - Zero-width characters (U+200B-U+200F, U+2060-U+206F)
 * - Bidirectional control characters (U+202A-U+202E)
 * - Line/paragraph separators (U+2028-U+2029)
 * - Variation selectors (U+FE00-U+FE0F)
 * - Other invisible formatting characters
 *
 * Uses alternation instead of character class to avoid biome lint warning about
 * combining characters in character classes.
 */
const INVISIBLE_CHARS_PATTERN =
  /\u200B|\u200C|\u200D|\u200E|\u200F|\u2028|\u2029|\u202A|\u202B|\u202C|\u202D|\u202E|\u202F|\u2060|\u2061|\u2062|\u2063|\u2064|\u2065|\u2066|\u2067|\u2068|\u2069|\u206A|\u206B|\u206C|\u206D|\u206E|\u206F|\uFEFF|\u00AD|\u034F|\u061C|\u115F|\u1160|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u180E|\u3164|\uFFA0|\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F/g;

/**
 * Normalizes confusable Unicode characters to their ASCII equivalents.
 * This prevents homoglyph attacks where attackers use lookalike characters
 * (e.g., Cyrillic 'a' instead of Latin 'a') to bypass keyword detection.
 *
 * Coverage focuses on characters that could spell injection keywords:
 * "ignore", "system", "instructions", "disregard", "previous", "forget", etc.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic lookalikes
  "\u0430": "a", // Cyrillic a
  "\u0435": "e", // Cyrillic e
  "\u043E": "o", // Cyrillic o
  "\u0440": "p", // Cyrillic r looks like p
  "\u0441": "c", // Cyrillic s looks like c
  "\u0443": "y", // Cyrillic u looks like y
  "\u0445": "x", // Cyrillic h looks like x
  "\u0410": "A", // Cyrillic A
  "\u0412": "B", // Cyrillic V looks like B
  "\u0415": "E", // Cyrillic E
  "\u041A": "K", // Cyrillic K
  "\u041C": "M", // Cyrillic M
  "\u041D": "H", // Cyrillic N looks like H
  "\u041E": "O", // Cyrillic O
  "\u0420": "P", // Cyrillic R looks like P
  "\u0421": "C", // Cyrillic S looks like C
  "\u0422": "T", // Cyrillic T
  "\u0423": "Y", // Cyrillic U looks like Y
  "\u0425": "X", // Cyrillic X
  // Greek lookalikes
  "\u03B1": "a", // Greek alpha
  "\u03B5": "e", // Greek epsilon
  "\u03BF": "o", // Greek omicron
  "\u03C1": "p", // Greek rho looks like p
  "\u0391": "A", // Greek Alpha
  "\u0392": "B", // Greek Beta
  "\u0395": "E", // Greek Epsilon
  "\u0397": "H", // Greek Eta
  "\u0399": "I", // Greek Iota
  "\u039A": "K", // Greek Kappa
  "\u039C": "M", // Greek Mu
  "\u039D": "N", // Greek Nu
  "\u039F": "O", // Greek Omicron
  "\u03A1": "P", // Greek Rho
  "\u03A4": "T", // Greek Tau
  "\u03A5": "Y", // Greek Upsilon
  "\u03A7": "X", // Greek Chi
  "\u0396": "Z", // Greek Zeta
  // Fullwidth characters (often used for obfuscation)
  "\uFF41": "a",
  "\uFF45": "e",
  "\uFF49": "i",
  "\uFF4F": "o",
  "\uFF55": "u",
  "\uFF4E": "n",
  "\uFF53": "s",
  "\uFF54": "t",
  "\uFF52": "r",
  // Common dash substitutions
  "\u2010": "-", // hyphen
  "\u2011": "-", // non-breaking hyphen
  "\u2012": "-", // figure dash
  "\u2013": "-", // en dash
  "\u2014": "-", // em dash
  "\u2212": "-", // minus sign

  // === Mathematical Alphanumeric Symbols (U+1D400-U+1D7FF) ===
  // These styled letters are commonly used for obfuscation attacks.
  // Only including letters needed for injection keywords: a-z coverage for
  // "ignore", "system", "instructions", "disregard", "previous", "forget", etc.

  // Mathematical Bold (U+1D400-U+1D433)
  "\u{1D400}": "A",
  "\u{1D401}": "B",
  "\u{1D402}": "C",
  "\u{1D403}": "D",
  "\u{1D404}": "E",
  "\u{1D405}": "F",
  "\u{1D406}": "G",
  "\u{1D407}": "H",
  "\u{1D408}": "I",
  "\u{1D409}": "J",
  "\u{1D40A}": "K",
  "\u{1D40B}": "L",
  "\u{1D40C}": "M",
  "\u{1D40D}": "N",
  "\u{1D40E}": "O",
  "\u{1D40F}": "P",
  "\u{1D410}": "Q",
  "\u{1D411}": "R",
  "\u{1D412}": "S",
  "\u{1D413}": "T",
  "\u{1D414}": "U",
  "\u{1D415}": "V",
  "\u{1D416}": "W",
  "\u{1D417}": "X",
  "\u{1D418}": "Y",
  "\u{1D419}": "Z",
  "\u{1D41A}": "a",
  "\u{1D41B}": "b",
  "\u{1D41C}": "c",
  "\u{1D41D}": "d",
  "\u{1D41E}": "e",
  "\u{1D41F}": "f",
  "\u{1D420}": "g",
  "\u{1D421}": "h",
  "\u{1D422}": "i",
  "\u{1D423}": "j",
  "\u{1D424}": "k",
  "\u{1D425}": "l",
  "\u{1D426}": "m",
  "\u{1D427}": "n",
  "\u{1D428}": "o",
  "\u{1D429}": "p",
  "\u{1D42A}": "q",
  "\u{1D42B}": "r",
  "\u{1D42C}": "s",
  "\u{1D42D}": "t",
  "\u{1D42E}": "u",
  "\u{1D42F}": "v",
  "\u{1D430}": "w",
  "\u{1D431}": "x",
  "\u{1D432}": "y",
  "\u{1D433}": "z",

  // Mathematical Italic (U+1D434-U+1D467) - commonly used in obfuscation
  "\u{1D434}": "A",
  "\u{1D435}": "B",
  "\u{1D436}": "C",
  "\u{1D437}": "D",
  "\u{1D438}": "E",
  "\u{1D439}": "F",
  "\u{1D43A}": "G",
  "\u{1D43B}": "H",
  "\u{1D43C}": "I",
  "\u{1D43D}": "J",
  "\u{1D43E}": "K",
  "\u{1D43F}": "L",
  "\u{1D440}": "M",
  "\u{1D441}": "N",
  "\u{1D442}": "O",
  "\u{1D443}": "P",
  "\u{1D444}": "Q",
  "\u{1D445}": "R",
  "\u{1D446}": "S",
  "\u{1D447}": "T",
  "\u{1D448}": "U",
  "\u{1D449}": "V",
  "\u{1D44A}": "W",
  "\u{1D44B}": "X",
  "\u{1D44C}": "Y",
  "\u{1D44D}": "Z",
  "\u{1D44E}": "a",
  "\u{1D44F}": "b",
  "\u{1D450}": "c",
  "\u{1D451}": "d",
  "\u{1D452}": "e",
  "\u{1D453}": "f",
  "\u{1D454}": "g",
  // U+1D455 is reserved (no character)
  "\u{1D456}": "i",
  "\u{1D457}": "j",
  "\u{1D458}": "k",
  "\u{1D459}": "l",
  "\u{1D45A}": "m",
  "\u{1D45B}": "n",
  "\u{1D45C}": "o",
  "\u{1D45D}": "p",
  "\u{1D45E}": "q",
  "\u{1D45F}": "r",
  "\u{1D460}": "s",
  "\u{1D461}": "t",
  "\u{1D462}": "u",
  "\u{1D463}": "v",
  "\u{1D464}": "w",
  "\u{1D465}": "x",
  "\u{1D466}": "y",
  "\u{1D467}": "z",

  // Mathematical Sans-Serif (U+1D5A0-U+1D5D3) - very readable, often used
  "\u{1D5A0}": "A",
  "\u{1D5A1}": "B",
  "\u{1D5A2}": "C",
  "\u{1D5A3}": "D",
  "\u{1D5A4}": "E",
  "\u{1D5A5}": "F",
  "\u{1D5A6}": "G",
  "\u{1D5A7}": "H",
  "\u{1D5A8}": "I",
  "\u{1D5A9}": "J",
  "\u{1D5AA}": "K",
  "\u{1D5AB}": "L",
  "\u{1D5AC}": "M",
  "\u{1D5AD}": "N",
  "\u{1D5AE}": "O",
  "\u{1D5AF}": "P",
  "\u{1D5B0}": "Q",
  "\u{1D5B1}": "R",
  "\u{1D5B2}": "S",
  "\u{1D5B3}": "T",
  "\u{1D5B4}": "U",
  "\u{1D5B5}": "V",
  "\u{1D5B6}": "W",
  "\u{1D5B7}": "X",
  "\u{1D5B8}": "Y",
  "\u{1D5B9}": "Z",
  "\u{1D5BA}": "a",
  "\u{1D5BB}": "b",
  "\u{1D5BC}": "c",
  "\u{1D5BD}": "d",
  "\u{1D5BE}": "e",
  "\u{1D5BF}": "f",
  "\u{1D5C0}": "g",
  "\u{1D5C1}": "h",
  "\u{1D5C2}": "i",
  "\u{1D5C3}": "j",
  "\u{1D5C4}": "k",
  "\u{1D5C5}": "l",
  "\u{1D5C6}": "m",
  "\u{1D5C7}": "n",
  "\u{1D5C8}": "o",
  "\u{1D5C9}": "p",
  "\u{1D5CA}": "q",
  "\u{1D5CB}": "r",
  "\u{1D5CC}": "s",
  "\u{1D5CD}": "t",
  "\u{1D5CE}": "u",
  "\u{1D5CF}": "v",
  "\u{1D5D0}": "w",
  "\u{1D5D1}": "x",
  "\u{1D5D2}": "y",
  "\u{1D5D3}": "z",

  // Mathematical Sans-Serif Bold (U+1D5D4-U+1D607) - another common variant
  "\u{1D5D4}": "A",
  "\u{1D5D5}": "B",
  "\u{1D5D6}": "C",
  "\u{1D5D7}": "D",
  "\u{1D5D8}": "E",
  "\u{1D5D9}": "F",
  "\u{1D5DA}": "G",
  "\u{1D5DB}": "H",
  "\u{1D5DC}": "I",
  "\u{1D5DD}": "J",
  "\u{1D5DE}": "K",
  "\u{1D5DF}": "L",
  "\u{1D5E0}": "M",
  "\u{1D5E1}": "N",
  "\u{1D5E2}": "O",
  "\u{1D5E3}": "P",
  "\u{1D5E4}": "Q",
  "\u{1D5E5}": "R",
  "\u{1D5E6}": "S",
  "\u{1D5E7}": "T",
  "\u{1D5E8}": "U",
  "\u{1D5E9}": "V",
  "\u{1D5EA}": "W",
  "\u{1D5EB}": "X",
  "\u{1D5EC}": "Y",
  "\u{1D5ED}": "Z",
  "\u{1D5EE}": "a",
  "\u{1D5EF}": "b",
  "\u{1D5F0}": "c",
  "\u{1D5F1}": "d",
  "\u{1D5F2}": "e",
  "\u{1D5F3}": "f",
  "\u{1D5F4}": "g",
  "\u{1D5F5}": "h",
  "\u{1D5F6}": "i",
  "\u{1D5F7}": "j",
  "\u{1D5F8}": "k",
  "\u{1D5F9}": "l",
  "\u{1D5FA}": "m",
  "\u{1D5FB}": "n",
  "\u{1D5FC}": "o",
  "\u{1D5FD}": "p",
  "\u{1D5FE}": "q",
  "\u{1D5FF}": "r",
  "\u{1D600}": "s",
  "\u{1D601}": "t",
  "\u{1D602}": "u",
  "\u{1D603}": "v",
  "\u{1D604}": "w",
  "\u{1D605}": "x",
  "\u{1D606}": "y",
  "\u{1D607}": "z",

  // Mathematical Monospace (U+1D670-U+1D6A3) - looks very similar to regular text
  "\u{1D670}": "A",
  "\u{1D671}": "B",
  "\u{1D672}": "C",
  "\u{1D673}": "D",
  "\u{1D674}": "E",
  "\u{1D675}": "F",
  "\u{1D676}": "G",
  "\u{1D677}": "H",
  "\u{1D678}": "I",
  "\u{1D679}": "J",
  "\u{1D67A}": "K",
  "\u{1D67B}": "L",
  "\u{1D67C}": "M",
  "\u{1D67D}": "N",
  "\u{1D67E}": "O",
  "\u{1D67F}": "P",
  "\u{1D680}": "Q",
  "\u{1D681}": "R",
  "\u{1D682}": "S",
  "\u{1D683}": "T",
  "\u{1D684}": "U",
  "\u{1D685}": "V",
  "\u{1D686}": "W",
  "\u{1D687}": "X",
  "\u{1D688}": "Y",
  "\u{1D689}": "Z",
  "\u{1D68A}": "a",
  "\u{1D68B}": "b",
  "\u{1D68C}": "c",
  "\u{1D68D}": "d",
  "\u{1D68E}": "e",
  "\u{1D68F}": "f",
  "\u{1D690}": "g",
  "\u{1D691}": "h",
  "\u{1D692}": "i",
  "\u{1D693}": "j",
  "\u{1D694}": "k",
  "\u{1D695}": "l",
  "\u{1D696}": "m",
  "\u{1D697}": "n",
  "\u{1D698}": "o",
  "\u{1D699}": "p",
  "\u{1D69A}": "q",
  "\u{1D69B}": "r",
  "\u{1D69C}": "s",
  "\u{1D69D}": "t",
  "\u{1D69E}": "u",
  "\u{1D69F}": "v",
  "\u{1D6A0}": "w",
  "\u{1D6A1}": "x",
  "\u{1D6A2}": "y",
  "\u{1D6A3}": "z",

  // === Superscript Letters (Modifier Letters & Phonetic Extensions) ===
  // These small raised letters are used in obfuscation to bypass detection
  "\u1D43": "a", // modifier letter small a
  "\u1D47": "b", // modifier letter small b
  "\u1D9C": "c", // modifier letter small c
  "\u1D48": "d", // modifier letter small d
  "\u1D49": "e", // modifier letter small e
  "\u1DA0": "f", // modifier letter small f
  "\u1D4D": "g", // modifier letter small g
  "\u02B0": "h", // modifier letter small h
  "\u2071": "i", // superscript latin small letter i
  "\u02B2": "j", // modifier letter small j
  "\u1D4F": "k", // modifier letter small k
  "\u02E1": "l", // modifier letter small l
  "\u1D50": "m", // modifier letter small m
  "\u207F": "n", // superscript latin small letter n
  "\u1D52": "o", // modifier letter small o
  "\u1D56": "p", // modifier letter small p
  "\u02B3": "r", // modifier letter small r
  "\u02E2": "s", // modifier letter small s
  "\u1D57": "t", // modifier letter small t
  "\u1D58": "u", // modifier letter small u
  "\u1D5B": "v", // modifier letter small v
  "\u02B7": "w", // modifier letter small w
  "\u02E3": "x", // modifier letter small x
  "\u02B8": "y", // modifier letter small y
  "\u1DBB": "z", // modifier letter small z

  // === Subscript Letters ===
  // Limited availability in Unicode, but include the ones that exist
  "\u2090": "a", // latin subscript small letter a
  "\u2091": "e", // latin subscript small letter e
  "\u1D62": "i", // latin subscript small letter i
  "\u2092": "o", // latin subscript small letter o
  "\u1D63": "r", // latin subscript small letter r
  "\u1D64": "u", // latin subscript small letter u
  "\u1D65": "v", // latin subscript small letter v
  "\u2093": "x", // latin subscript small letter x

  // === Superscript/Subscript Numbers (for completeness) ===
  "\u00B9": "1", // superscript one
  "\u00B2": "2", // superscript two
  "\u00B3": "3", // superscript three
  "\u2070": "0", // superscript zero
  "\u2074": "4", // superscript four
  "\u2075": "5", // superscript five
  "\u2076": "6", // superscript six
  "\u2077": "7", // superscript seven
  "\u2078": "8", // superscript eight
  "\u2079": "9", // superscript nine
  "\u2080": "0", // subscript zero
  "\u2081": "1", // subscript one
  "\u2082": "2", // subscript two
  "\u2083": "3", // subscript three
  "\u2084": "4", // subscript four
  "\u2085": "5", // subscript five
  "\u2086": "6", // subscript six
  "\u2087": "7", // subscript seven
  "\u2088": "8", // subscript eight
  "\u2089": "9", // subscript nine
};

// Use 'u' flag for proper Unicode handling of astral plane characters (U+1D400+)
// Without 'u', surrogate pairs are matched as separate characters
const HOMOGLYPH_PATTERN = new RegExp(
  `[${Object.keys(HOMOGLYPH_MAP).join("")}]`,
  "gu"
);

const normalizeHomoglyphs = (str: string): string =>
  str.replace(HOMOGLYPH_PATTERN, (char) => HOMOGLYPH_MAP[char] ?? char);

/**
 * Prompt injection detection patterns, broken into named sub-patterns for maintainability.
 * Combined using alternation for O(n) single-pass matching instead of O(n * patterns).
 */

// XML/HTML-like tags that could close our <ci_output> wrapper or inject roles
// Tolerates whitespace variations: `< /system>`, `<system >`, etc.
const XML_TAG_INJECTION =
  /<\s*\/?\s*(?:ci_output|system|user|assistant|human|instructions|function|tool|message|prompt|context|task)[^>]*>/;

// Claude/Anthropic-style message separators
const CLAUDE_MARKERS = /\n\n(?:Human|Assistant|System)\s*:/;

// Llama-style markers
const LLAMA_MARKERS = /\[\/INST\]|\[INST\]|<<SYS>>|<\/?SYS>>/;

// OpenAI chat format markers (<|im_start|>, <|im_end|>, etc.)
const OPENAI_MARKERS =
  /<\|(?:im_start|im_end|endoftext|end|system|user|assistant)\|>/;

// Common prompt injection phrases
// Uses bounded quantifiers (\s{1,20}) to prevent catastrophic backtracking on crafted input.
// JS lacks possessive quantifiers and atomic groups, so bounded ranges are the alternative.
const INJECTION_PHRASES =
  /ignore\s{1,20}(?:all\s{1,20})?(?:previous|prior|above)\s{1,20}instructions?|disregard\s{1,20}(?:all\s{1,20})?(?:previous|above)|forget\s{1,20}(?:all\s{1,20})?(?:previous|everything\s{1,20}above)|new\s{1,20}instructions?\s{0,10}:|system\s{0,10}prompt\s{0,10}:|you\s{1,20}are\s{1,20}now\s{1,20}|act\s{1,20}as\s{1,20}if\s{1,20}|pretend\s{1,20}(?:you\s{1,20}are|to\s{1,20}be)\s{1,20}|override\s{1,20}(?:your\s{1,20})?(?:instructions|rules|programming)|actually\s{1,20}your\s{1,20}(?:real\s{1,20})?instructions|from\s{1,20}now\s{1,20}on\s{1,20}|stop\s{1,20}being\s{1,20}a\s{1,20}|jailbreak|DAN\s{0,10}mode|developer\s{0,10}mode\s{0,10}enabled|base64\s{0,10}(?:decode|encoded)\s{0,10}instructions?|begin\s{1,20}(?:new\s{1,20})?(?:conversation|session)|end\s{1,20}(?:system\s{1,20})?(?:message|prompt)/;

// Combined pattern from all sub-patterns
const PROMPT_INJECTION_PATTERN = new RegExp(
  [
    XML_TAG_INJECTION,
    CLAUDE_MARKERS,
    LLAMA_MARKERS,
    OPENAI_MARKERS,
    INJECTION_PHRASES,
  ]
    .map((r) => r.source)
    .join("|"),
  "gi"
);

/**
 * XML escape map for single-pass replacement.
 */
const XML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/**
 * Escapes XML special characters to prevent tag injection.
 * This is the primary structural defense - even if pattern matching fails,
 * escaped content cannot break out of XML structure.
 *
 * Uses single-pass replacement to avoid creating intermediate strings.
 */
const escapeXml = (str: string): string =>
  str.replace(/[&<>"']/g, (char) => XML_ESCAPE_MAP[char] ?? char);

/**
 * Sanitizes content to prevent prompt injection attacks.
 *
 * Defense in depth approach:
 * 1. Remove invisible Unicode characters that could bypass pattern matching
 * 2. Normalize homoglyphs to prevent lookalike character attacks
 * 3. Filter known injection patterns (behavioral defense)
 * 4. XML-escape all < and > characters (structural defense)
 *
 * The XML escaping is the primary defense - it ensures content cannot break
 * out of the <ci_output> wrapper regardless of attack vector.
 */
export const sanitizeForPrompt = (content: string): string => {
  // Step 1: Remove invisible characters that could hide malicious content
  let result = content.replace(INVISIBLE_CHARS_PATTERN, "");

  // Step 2: Normalize homoglyphs before pattern matching
  result = normalizeHomoglyphs(result);

  // Step 3: Filter known injection patterns (defense in depth)
  result = result.replace(PROMPT_INJECTION_PATTERN, "[FILTERED]");

  // Step 4: XML escape as primary structural defense
  return escapeXml(result);
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

// Minimum consecutive noise lines before showing an omission marker.
// Avoids cluttering output with markers for small gaps.
const MIN_CONSECUTIVE_NOISE_FOR_MARKER = 3;

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
    // Only check importance if line looks like noise - avoids redundant regex test
    const keep = !isNoise || IMPORTANT_PATTERN.test(line);

    if (keep) {
      if (consecutiveNoiseCount > MIN_CONSECUTIVE_NOISE_FOR_MARKER) {
        result.push(`... [${consecutiveNoiseCount} lines omitted]`);
      }
      consecutiveNoiseCount = 0;
      result.push(line);
    } else {
      consecutiveNoiseCount++;
    }
  }

  if (consecutiveNoiseCount > MIN_CONSECUTIVE_NOISE_FOR_MARKER) {
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
 * Result of truncation operation.
 */
export interface TruncateResult {
  content: string;
  truncated: boolean;
}

/**
 * Truncates content for the prompt to avoid excessive token usage.
 * Returns both the content and whether truncation occurred.
 */
export const truncateContent = (
  content: string,
  maxLength = 15_000
): TruncateResult => {
  if (content.length <= maxLength) {
    return { content, truncated: false };
  }
  return {
    content: `${content.slice(0, maxLength)}\n... [truncated, ${content.length - maxLength} more characters]`,
    truncated: true,
  };
};

/**
 * Result of preparing content for the prompt.
 */
export interface PrepareResult {
  content: string;
  truncated: boolean;
}

/**
 * Prepares CI output for LLM processing with compaction, truncation, and sanitization.
 * Applies all security measures to prevent prompt injection and reduce costs.
 *
 * Order of operations optimized for performance:
 * 1. Compact - removes noise (processes up to 3x target, ~45KB)
 * 2. Truncate - cuts to final size (15KB default)
 * 3. Sanitize - security pass only on final content (smallest input)
 *
 * Returns both the prepared content and whether truncation occurred after compaction.
 * This ensures the truncation flag accurately reflects whether content was lost,
 * not just whether the original input exceeded the limit.
 */
export const prepareForPrompt = (
  content: string,
  maxLength = 15_000
): PrepareResult => {
  const compacted = compactCiOutput(content, maxLength);
  const { content: truncated, truncated: wasTruncated } = truncateContent(
    compacted,
    maxLength
  );
  return {
    content: sanitizeForPrompt(truncated),
    truncated: wasTruncated,
  };
};
