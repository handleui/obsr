import { normalizeHomoglyphs } from "./homoglyphs.js";

// HACK: character class for \uFE00-\uFE0F (16 variation selectors) + alternation for the rest
// Biome flags mixed combining chars in classes, so ranges with combining marks use alternation
const INVISIBLE_CHARS_PATTERN =
  /[\uFE00-\uFE0F]|\u200B|\u200C|\u200D|\u200E|\u200F|\u2028|\u2029|\u202A|\u202B|\u202C|\u202D|\u202E|\u202F|\u2060|\u2061|\u2062|\u2063|\u2064|\u2065|\u2066|\u2067|\u2068|\u2069|\u206A|\u206B|\u206C|\u206D|\u206E|\u206F|\uFEFF|\u00AD|\u034F|\u061C|\u115F|\u1160|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u180E|\u3164|\uFFA0/g;

const XML_TAG_INJECTION =
  /<\s*\/?\s*(?:ci_output|system|user|assistant|human|instructions|function|tool|message|prompt|context|task)[^>]*>/;

const CLAUDE_MARKERS = /\n\n(?:Human|Assistant|System)\s*:/;
const LLAMA_MARKERS = /\[\/INST\]|\[INST\]|<<SYS>>|<\/?SYS>>/;
const OPENAI_MARKERS =
  /<\|(?:im_start|im_end|endoftext|end|system|user|assistant)\|>/;

// HACK: bounded quantifiers (\s{1,20}) instead of \s+ to prevent catastrophic backtracking
const INJECTION_PHRASES =
  /ignore\s{1,20}(?:all\s{1,20})?(?:previous|prior|above)\s{1,20}instructions?|disregard\s{1,20}(?:all\s{1,20})?(?:previous|above)|forget\s{1,20}(?:all\s{1,20})?(?:previous|everything\s{1,20}above)|new\s{1,20}instructions?\s{0,10}:|system\s{0,10}prompt\s{0,10}:|you\s{1,20}are\s{1,20}now\s{1,20}|act\s{1,20}as\s{1,20}if\s{1,20}|pretend\s{1,20}(?:you\s{1,20}are|to\s{1,20}be)\s{1,20}|override\s{1,20}(?:your\s{1,20})?(?:instructions|rules|programming)|actually\s{1,20}your\s{1,20}(?:real\s{1,20})?instructions|from\s{1,20}now\s{1,20}on\s{1,20}|stop\s{1,20}being\s{1,20}a\s{1,20}|jailbreak|DAN\s{0,10}mode|developer\s{0,10}mode\s{0,10}enabled|base64\s{0,10}(?:decode|encoded)\s{0,10}instructions?|begin\s{1,20}(?:new\s{1,20})?(?:conversation|session)|end\s{1,20}(?:system\s{1,20})?(?:message|prompt)/;

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

const XML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const escapeXml = (str: string): string =>
  str.replace(/[&<>"']/g, (char) => XML_ESCAPE_MAP[char] ?? char);

export const sanitizeForPrompt = (content: string): string => {
  let result = content.replace(INVISIBLE_CHARS_PATTERN, "");
  result = normalizeHomoglyphs(result);
  result = result.replace(PROMPT_INJECTION_PATTERN, "[FILTERED]");
  return escapeXml(result);
};

const NOISE_SOURCES: Array<{ name: string; pattern: string }> = [
  { name: "trailing-whitespace", pattern: "\\s*$" },
  { name: "separator-lines", pattern: "[-=]{3,}$" },
  { name: "test-summary", pattern: "\\s*\\d+\\s+(?:passing|pending)\\b" },
  {
    name: "package-warnings",
    pattern: "(?:npm|yarn)\\s+(?:warn|warning|notice)\\b",
  },
  {
    name: "internal-stack",
    pattern: "\\s*at\\s+(?:Object\\.|Module\\.|Function\\.|node:|internal\\/)",
  },
  {
    name: "download-progress",
    pattern: "(?:Downloading|Installing|Resolving)\\b",
  },
  { name: "caret-underline", pattern: "\\s*[\\^~]+\\s*$" },
  {
    name: "gh-actions-commands",
    pattern:
      "^::(?:group|endgroup|add-matcher|remove-matcher|save-state|set-output)\\b",
  },
  {
    name: "timing-lines",
    pattern: "^\\s*(?:real|user|sys)\\s+\\d+m[\\d.]+s$",
  },
  {
    name: "progress-bars",
    pattern: "\\[?[#=>\\-\\s]{5,}\\]?\\s*\\d+%",
  },
];

const NOISE_PATTERN = new RegExp(
  `^(?:${NOISE_SOURCES.map((s) => s.pattern).join("|")})`,
  "i"
);

const IMPORTANT_PATTERN =
  /error|warning|failed|failure|exception|:\d+:\d+|line\s+\d+|^\s*>\s+\d+\s*\||FAIL|PASS|ERROR|WARN|::(?:error|warning)\s/i;

const EARLY_CUTOFF_MULTIPLIER = 3;
const MIN_CONSECUTIVE_NOISE_FOR_MARKER = 3;
const MAX_SEGMENTS = 1000;
const MAX_SEGMENT_LINES = 1_000_000;

export interface LogSegment {
  start: number;
  end: number;
  signal: boolean;
}

interface FilterResult {
  lines: string[];
  segments: LogSegment[];
  segmentsTruncated: boolean;
  removedCount: number;
}

const PKG_MANAGER_NOISE = /^\s*(?:npm|yarn)\s+(?:warn|warning|notice)\b/i;

const isSignalLine = (line: string): boolean => {
  // Fast path: most CI error lines contain diagnostic keywords — check first
  if (IMPORTANT_PATTERN.test(line)) {
    // Even if it matches noise, signal wins unless it's just a package manager warning
    return !PKG_MANAGER_NOISE.test(line);
  }
  // No diagnostic keywords — check if it matches noise patterns
  return !NOISE_PATTERN.test(line);
};

const appendOmissionMarker = (
  result: string[],
  noiseCount: number,
  noiseStartLine: number,
  noiseEndLine: number
): void => {
  if (noiseCount > MIN_CONSECUTIVE_NOISE_FOR_MARKER) {
    result.push(`[lines ${noiseStartLine}-${noiseEndLine} omitted]`);
  }
};

const clampLineNum = (lineNum: number): number =>
  Math.max(1, Math.min(lineNum, MAX_SEGMENT_LINES));

const pushSegment = (
  state: FilterState,
  start: number,
  end: number,
  signal: boolean
): void => {
  if (state.segments.length >= MAX_SEGMENTS) {
    state.truncated = true;
    return;
  }
  const cStart = clampLineNum(start);
  const cEnd = clampLineNum(end);
  if (cStart <= cEnd) {
    state.segments.push({ start: cStart, end: cEnd, signal });
  }
};

interface FilterState {
  result: string[];
  segments: LogSegment[];
  truncated: boolean;
  consecutiveNoiseCount: number;
  noiseStartLine: number;
  signalStartLine: number;
  inSignal: boolean;
}

const handleSignalLine = (
  state: FilterState,
  lineNum: number,
  line: string
): void => {
  if (state.consecutiveNoiseCount > 0) {
    pushSegment(state, state.noiseStartLine, lineNum - 1, false);
  }
  appendOmissionMarker(
    state.result,
    state.consecutiveNoiseCount,
    state.noiseStartLine,
    lineNum - 1
  );
  state.consecutiveNoiseCount = 0;
  if (!state.inSignal) {
    state.signalStartLine = lineNum;
    state.inSignal = true;
  }
  state.result.push(`[${lineNum}] ${line}`);
};

const handleNoiseLine = (state: FilterState, lineNum: number): void => {
  if (state.inSignal) {
    pushSegment(state, state.signalStartLine, lineNum - 1, true);
    state.inSignal = false;
  }
  if (state.consecutiveNoiseCount === 0) {
    state.noiseStartLine = lineNum;
  }
  state.consecutiveNoiseCount++;
};

const finalizeSegments = (state: FilterState, totalLines: number): void => {
  const finalLineNum = clampLineNum(totalLines);
  if (state.consecutiveNoiseCount > 0) {
    pushSegment(state, state.noiseStartLine, finalLineNum, false);
  } else if (state.inSignal) {
    pushSegment(state, state.signalStartLine, finalLineNum, true);
  }
  appendOmissionMarker(
    state.result,
    state.consecutiveNoiseCount,
    state.noiseStartLine,
    totalLines
  );
};

const filterNoiseLines = (lines: string[], lineOffset = 0): FilterResult => {
  const state: FilterState = {
    result: [],
    segments: [],
    truncated: false,
    consecutiveNoiseCount: 0,
    noiseStartLine: 0,
    signalStartLine: 0,
    inSignal: false,
  };

  let removedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1 + lineOffset;
    const line = lines[i] as string;
    if (isSignalLine(line)) {
      handleSignalLine(state, lineNum, line);
    } else {
      handleNoiseLine(state, lineNum);
      removedCount++;
    }
  }

  finalizeSegments(state, lines.length + lineOffset);
  return {
    lines: state.result,
    segments: state.segments,
    segmentsTruncated: state.truncated,
    removedCount,
  };
};

export interface CompactResult {
  content: string;
  segments: LogSegment[];
  segmentsTruncated: boolean;
  removedCount: number;
  totalLines: number;
}

const MAX_NEWLINE_SCAN_BYTES = 500_000;

const NEWLINE_CHAR_CODE = 10;

const countNewlinesInRange = (
  str: string,
  start: number,
  end: number
): number => {
  let count = 0;
  for (let i = start; i < end; i++) {
    if (str.charCodeAt(i) === NEWLINE_CHAR_CODE) {
      count++;
    }
  }
  return count;
};

// HACK: samples first 500KB and extrapolates — can be 2-3x off for skewed logs, acceptable for noise segments
const countNewlinesInRegion = (
  str: string,
  start: number,
  length: number
): number => {
  const end = start + length;
  if (length <= MAX_NEWLINE_SCAN_BYTES) {
    return countNewlinesInRange(str, start, end);
  }
  const sampleEnd = start + MAX_NEWLINE_SCAN_BYTES;
  const sampleCount = countNewlinesInRange(str, start, sampleEnd);
  return Math.floor((sampleCount / MAX_NEWLINE_SCAN_BYTES) * length);
};

const compactSmallContent = (content: string): CompactResult => {
  const lines = content.split("\n");
  const {
    lines: result,
    segments,
    segmentsTruncated,
    removedCount,
  } = filterNoiseLines(lines);
  return {
    content: result.join("\n"),
    segments,
    segmentsTruncated,
    removedCount,
    totalLines: lines.length,
  };
};

const mergeSegments = (
  headResult: FilterResult,
  tailResult: FilterResult,
  headLineCount: number,
  tailLineOffset: number
): { segments: LogSegment[]; segmentsTruncated: boolean } => {
  const segments: LogSegment[] = headResult.segments;
  let segmentsTruncated =
    headResult.segmentsTruncated || tailResult.segmentsTruncated;

  if (segments.length < MAX_SEGMENTS) {
    const omittedStart = clampLineNum(headLineCount + 1);
    const omittedEnd = clampLineNum(tailLineOffset);
    if (omittedStart <= omittedEnd) {
      segments.push({ start: omittedStart, end: omittedEnd, signal: false });
    }
  } else {
    segmentsTruncated = true;
  }

  for (const seg of tailResult.segments) {
    if (segments.length >= MAX_SEGMENTS) {
      segmentsTruncated = true;
      break;
    }
    segments.push(seg);
  }

  return { segments, segmentsTruncated };
};

const compactLargeContent = (
  content: string,
  budget: number
): CompactResult => {
  const headBudget = Math.ceil(budget / 2);
  const tailStart = content.length - Math.floor(budget / 2);
  const omittedLength = tailStart - headBudget;

  const headLines = content.slice(0, headBudget).split("\n");
  const headResult = filterNoiseLines(headLines);

  const middleLineCount = countNewlinesInRegion(
    content,
    headBudget,
    omittedLength
  );
  const tailLineOffset = headLines.length + middleLineCount;

  const tailLines = content.slice(tailStart).split("\n");
  const tailResult = filterNoiseLines(tailLines, tailLineOffset);

  const result = [
    ...headResult.lines,
    `[... ${omittedLength} chars omitted (lines ${headLines.length + 1}-${tailLineOffset}) ...]`,
    ...tailResult.lines,
  ];

  const { segments, segmentsTruncated } = mergeSegments(
    headResult,
    tailResult,
    headLines.length,
    tailLineOffset
  );

  const totalLines = headLines.length + middleLineCount + tailLines.length;
  const removedCount =
    headResult.removedCount + middleLineCount + tailResult.removedCount;

  return {
    content: result.join("\n"),
    segments,
    segmentsTruncated,
    removedCount,
    totalLines,
  };
};

export const compactCiOutput = (
  content: string,
  targetLength = 15_000
): CompactResult => {
  const budget = targetLength * EARLY_CUTOFF_MULTIPLIER;

  if (content.length <= budget) {
    return compactSmallContent(content);
  }

  return compactLargeContent(content, budget);
};

export interface TruncateResult {
  content: string;
  truncated: boolean;
}

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

export interface PrepareResult {
  content: string;
  truncated: boolean;
  segments: LogSegment[];
  segmentsTruncated: boolean;
  metrics: {
    originalLength: number;
    afterPreprocessLength: number;
    truncatedChars: number;
    noiseRatio: number;
  };
}

export const prepareForPrompt = (
  content: string,
  maxLength = 15_000
): PrepareResult => {
  const originalLength = content.length;
  const {
    content: compacted,
    segments,
    segmentsTruncated,
    removedCount,
    totalLines,
  } = compactCiOutput(content, maxLength);
  const afterPreprocessLength = compacted.length;
  const { content: truncated, truncated: wasTruncated } = truncateContent(
    compacted,
    maxLength
  );
  const truncatedChars = wasTruncated ? afterPreprocessLength - maxLength : 0;
  const noiseRatio = totalLines > 0 ? removedCount / totalLines : 0;

  return {
    content: sanitizeForPrompt(truncated),
    truncated: wasTruncated,
    segments,
    segmentsTruncated,
    metrics: {
      originalLength,
      afterPreprocessLength,
      truncatedChars,
      noiseRatio,
    },
  };
};
