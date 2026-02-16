# SPEC-04: Extraction Pipeline Hardening

## Summary
Improve CI log parsing quality, fix truncation blind spots, and broaden platform support.

## Tasks

### 1. Smarter truncation strategy (replace hard 45KB cutoff)
- **Where**: `packages/extract/src/preprocess.ts` (line ~235)
- **Problem**: `EARLY_CUTOFF_MULTIPLIER = 3` → hard cutoff at `targetLength * 3 = 45KB`. Errors after cutoff are silently lost. Many CI logs put summary/failure sections at the END.
- **Fix options** (pick one or combine):
  A. **Tail-aware**: Keep first 22KB + last 22KB, mark middle as omitted. Captures both preamble and summary.
  B. **Error-density scoring**: Scan full log cheaply (regex for error keywords), keep highest-density regions.
  C. **Two-pass**: First pass identifies error regions (cheap regex), second pass extracts only those regions with context.
- **Recommendation**: Option A is simplest and catches the common case (Jest/Vitest print summary at end).
- **Must preserve**: Segment tracking, omission markers, and early cutoff metadata.

### 2. Add Windows path support to related-files extraction
- **Where**: `packages/extract/src/related-files.ts` (lines 13-22)
- **Problem**: File path regexes use `/` only. Windows CI (GitHub Actions `windows-latest`) produces backslash paths like `C:\Users\runner\work\src\index.ts:10:5`.
- **Fix**: Update path separator patterns to `[\\/]`. Add Windows absolute path pattern: `/[A-Z]:\\[\w.\\\/-]+\.[a-z]+:\d+/gi`.
- **Also**: Exclusion patterns (line 25-32) use `/` — update to `[\\/]`.

### 3. Handle GitHub Actions annotation format
- **Where**: `packages/extract/src/preprocess.ts`, noise/signal patterns
- **Problem**: GitHub Actions annotations (`::error file=...::message`) not explicitly handled in signal detection. May be filtered as noise.
- **Fix**: Add to `IMPORTANT_PATTERN`: `::(?:error|warning)\s`. Also parse structured annotation format in extraction for richer metadata (file, line, col already encoded in the annotation).

### 4. Improve noise pattern maintainability
- **Where**: `packages/extract/src/preprocess.ts` (lines 49-53)
- **Problem**: `NOISE_PATTERN` is a single massive regex with many alternatives. Hard to maintain, debug, or extend. New CI tool formats break silently.
- **Fix**: Refactor into named pattern array:
  ```ts
  const NOISE_PATTERNS = [
    { name: "empty", pattern: /^\s*$/ },
    { name: "separator", pattern: /^[-=]{3,}$/ },
    { name: "progress", pattern: /\d+ (?:passing|pending)\b/ },
    // ...
  ];
  const NOISE_PATTERN = new RegExp(NOISE_PATTERNS.map(p => p.pattern.source).join("|"));
  ```
- **Benefit**: Each pattern testable individually. Easy to add new patterns. Debug logs can say "filtered by: separator" instead of "filtered by noise".

### 5. Add extraction quality metrics
- **Where**: `packages/extract/src/extract.ts`, return type
- **Problem**: No visibility into extraction quality. Can't tell if AI missed errors, if truncation lost data, or if noise filtering was too aggressive.
- **Fix**: Add to `ExtractionResult`:
  ```ts
  metrics: {
    originalLength: number;      // Raw log size
    afterPreprocessLength: number; // After noise filter
    truncatedChars: number;       // Chars lost to cutoff
    noiseRatio: number;           // % filtered as noise
    errorDensity: number;         // errors per KB of signal
  }
  ```
- **Use**: Surface in UI for heal debugging. Alert if truncatedChars > 0 and errorCount is low (likely missed errors).

### 6. Cap max errors in extraction schema
- **Where**: `packages/types/src/diagnostic.ts`, Zod schema
- **Problem**: No limit on error array size. AI could return hundreds of errors, consuming tokens and storage.
- **Fix**: Add `.max(100)` to errors array in Zod schema. 100 errors is more than enough for any single CI run. If AI returns more, it's likely duplicates or noise.

## Dependencies
- None. Fully self-contained in `packages/extract/` and `packages/types/`.

## Risk
- Task 1 (truncation strategy) is the highest risk — changes affect every heal. Test against real CI logs from multiple providers (GitHub Actions, CircleCI, etc.).
- Task 4 (refactor) is pure refactor — should not change behavior. Verify with existing tests.
