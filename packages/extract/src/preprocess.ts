import { normalizeHomoglyphs } from "./homoglyphs.js";

const INVISIBLE_CHARS_PATTERN =
  /\u200B|\u200C|\u200D|\u200E|\u200F|\u2028|\u2029|\u202A|\u202B|\u202C|\u202D|\u202E|\u202F|\u2060|\u2061|\u2062|\u2063|\u2064|\u2065|\u2066|\u2067|\u2068|\u2069|\u206A|\u206B|\u206C|\u206D|\u206E|\u206F|\uFEFF|\u00AD|\u034F|\u061C|\u115F|\u1160|\u17B4|\u17B5|\u180B|\u180C|\u180D|\u180E|\u3164|\uFFA0|\uFE00|\uFE01|\uFE02|\uFE03|\uFE04|\uFE05|\uFE06|\uFE07|\uFE08|\uFE09|\uFE0A|\uFE0B|\uFE0C|\uFE0D|\uFE0E|\uFE0F/g;

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

const NOISE_PATTERN =
  /^(?:\s*$|[-=]{3,}$|\s*\d+\s+(?:passing|pending)\b|(?:npm|yarn)\s+(?:warn|warning|notice)\b|\s*at\s+(?:Object\.|Module\.|Function\.|node:|internal\/)|(?:Downloading|Installing|Resolving)\b|\s*[\^~]+\s*$)/i;

const IMPORTANT_PATTERN =
  /error|warning|failed|failure|exception|:\d+:\d+|line\s+\d+|^\s*>\s+\d+\s*\||FAIL|PASS|ERROR|WARN/i;

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
}

const PKG_MANAGER_NOISE = /^\s*(?:npm|yarn)\s+(?:warn|warning|notice)\b/i;

const isSignalLine = (line: string): boolean => {
  if (!NOISE_PATTERN.test(line)) {
    return true;
  }
  return !PKG_MANAGER_NOISE.test(line) && IMPORTANT_PATTERN.test(line);
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

const filterNoiseLines = (lines: string[]): FilterResult => {
  const state: FilterState = {
    result: [],
    segments: [],
    truncated: false,
    consecutiveNoiseCount: 0,
    noiseStartLine: 0,
    signalStartLine: 0,
    inSignal: false,
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i] as string;
    if (isSignalLine(line)) {
      handleSignalLine(state, lineNum, line);
    } else {
      handleNoiseLine(state, lineNum);
    }
  }

  finalizeSegments(state, lines.length);
  return {
    lines: state.result,
    segments: state.segments,
    segmentsTruncated: state.truncated,
  };
};

export interface CompactResult {
  content: string;
  segments: LogSegment[];
  segmentsTruncated: boolean;
}

const MAX_NEWLINE_SCAN_BYTES = 500_000;

const NEWLINE_CHAR_CODE = 10;

const countNewlinesInSlice = (str: string, end: number): number => {
  let count = 0;
  for (let i = 0; i < end; i++) {
    if (str.charCodeAt(i) === NEWLINE_CHAR_CODE) {
      count++;
    }
  }
  return count;
};

// Approximates newline count for large strings by sampling the first 500KB.
// Assumes uniform newline distribution — can be 2-3x off for skewed logs
// (e.g. dense short-line preamble followed by long output lines).
// Acceptable since this only determines the noise segment endpoint after early cutoff.
const countNewlines = (str: string): number => {
  if (str.length <= MAX_NEWLINE_SCAN_BYTES) {
    return countNewlinesInSlice(str, str.length);
  }
  const sampleCount = countNewlinesInSlice(str, MAX_NEWLINE_SCAN_BYTES);
  return Math.floor((sampleCount / MAX_NEWLINE_SCAN_BYTES) * str.length);
};

export const compactCiOutput = (
  content: string,
  targetLength = 15_000
): CompactResult => {
  const earlyCutoff = targetLength * EARLY_CUTOFF_MULTIPLIER;
  const truncatedEarly = content.length > earlyCutoff;
  const toProcess = truncatedEarly ? content.slice(0, earlyCutoff) : content;

  const lines = toProcess.split("\n");
  const {
    lines: result,
    segments,
    segmentsTruncated,
  } = filterNoiseLines(lines);

  if (truncatedEarly && segments.length < MAX_SEGMENTS) {
    result.push(
      `[early cutoff at line ${lines.length}, ${content.length - earlyCutoff} chars not processed]`
    );
    const totalLines = lines.length + countNewlines(content.slice(earlyCutoff));
    if (totalLines > lines.length) {
      const start = Math.max(1, Math.min(lines.length + 1, MAX_SEGMENT_LINES));
      const end = Math.max(1, Math.min(totalLines, MAX_SEGMENT_LINES));
      if (start <= end) {
        segments.push({
          start,
          end,
          signal: false,
        });
      }
    }
  }

  return { content: result.join("\n"), segments, segmentsTruncated };
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
}

export const prepareForPrompt = (
  content: string,
  maxLength = 15_000
): PrepareResult => {
  const {
    content: compacted,
    segments,
    segmentsTruncated,
  } = compactCiOutput(content, maxLength);
  const { content: truncated, truncated: wasTruncated } = truncateContent(
    compacted,
    maxLength
  );
  return {
    content: sanitizeForPrompt(truncated),
    truncated: wasTruncated,
    segments,
    segmentsTruncated,
  };
};
