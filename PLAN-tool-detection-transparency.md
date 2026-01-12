# Plan: Tool Detection Transparency

## Goal

When processing CI logs, detect tools that were run but we don't have parsers for, and inform users in the PR comment:

> "Detected vitest, jest - parsers not available yet"

This sets expectations and helps users understand why some errors might not appear.

## Current Infrastructure

The parser registry already supports:
- `detectTools(runCommand)` - Detect tools from command strings
- `hasDedicatedParser(id)` - Check if tool has a parser
- `unsupportedTools(result)` - Filter to unsupported tools
- `formatUnsupportedToolsWarning()` - Format warning message

**Key file**: `packages/parser/src/registry.ts`

## Implementation Plan

### Phase 1: Add Tool Patterns for Common Unsupported Tools

**File**: `packages/parser/src/registry.ts` (around line 162)

Add patterns for tools we detect but don't parse yet:

```typescript
// Test runners (no dedicated parsers yet)
{ pattern: /(?:^|\s|\/)vitest\b/, parserID: "vitest", displayName: "Vitest" },
{ pattern: /(?:^|\s|\/)jest\b/, parserID: "jest", displayName: "Jest" },
{ pattern: /(?:^|\s|\/)mocha\b/, parserID: "mocha", displayName: "Mocha" },
{ pattern: /(?:^|\s|\/)ava\b/, parserID: "ava", displayName: "AVA" },

// Python test runners (pytest already supported, add others)
{ pattern: /(?:^|\s|\/)unittest\b/, parserID: "unittest", displayName: "unittest" },
{ pattern: /(?:^|\s|\/)nose2?\b/, parserID: "nose", displayName: "nose" },

// Other linters
{ pattern: /(?:^|\s|\/)prettier\b/, parserID: "prettier", displayName: "Prettier" },
{ pattern: /(?:^|\s|\/)stylelint\b/, parserID: "stylelint", displayName: "stylelint" },
{ pattern: /(?:^|\s|\/)oxlint\b/, parserID: "oxlint", displayName: "oxlint" },

// Build tools
{ pattern: /(?:^|\s|\/)webpack\b/, parserID: "webpack", displayName: "webpack" },
{ pattern: /(?:^|\s|\/)vite\b/, parserID: "vite", displayName: "Vite" },
{ pattern: /(?:^|\s|\/)esbuild\b/, parserID: "esbuild", displayName: "esbuild" },
{ pattern: /(?:^|\s|\/)rollup\b/, parserID: "rollup", displayName: "Rollup" },
{ pattern: /(?:^|\s|\/)turbo(pack|repo)?\b/, parserID: "turbo", displayName: "Turbo" },
```

### Phase 2: Expose Detection from Parser Package

**File**: `packages/parser/src/index.ts`

Export the detection helpers:

```typescript
export {
  detectTools,
  unsupportedTools,
  DetectedTool,
  DetectionResult,
} from "./registry";
```

### Phase 3: Detect Tools in Webhook

**File**: `apps/api/src/services/error-parser.ts`

Add detection when parsing workflow logs:

```typescript
import { detectTools, unsupportedTools, parseGitHubLogs } from "@detent/parser";

export interface WorkflowParseResult {
  errors: ParsedError[];
  metadata: ParseMetadata;
  unsupportedTools?: string[];  // NEW: List of detected but unsupported tools
}

export const parseWorkflowLogs = (
  logs: string,
  metadata: { totalBytes: number; jobCount: number },
  runCommands?: string[]  // NEW: Commands from step names
): WorkflowParseResult => {
  // ... existing parsing ...

  // Detect tools from run commands
  let detectedUnsupported: string[] = [];
  if (runCommands) {
    for (const cmd of runCommands) {
      const result = detectTools(cmd, { checkSupport: true });
      const unsupported = unsupportedTools(result);
      detectedUnsupported.push(...unsupported.map(t => t.displayName));
    }
    // Dedupe
    detectedUnsupported = [...new Set(detectedUnsupported)];
  }

  return {
    errors,
    metadata: { ... },
    unsupportedTools: detectedUnsupported.length > 0 ? detectedUnsupported : undefined,
  };
};
```

### Phase 4: Pass Run Commands from Webhook

**File**: `apps/api/src/routes/webhooks.ts`

When fetching logs, extract step names (requires step tracking from `PLAN-step-tracking.md`):

```typescript
// For now, detect from workflow name and common patterns in logs
const runCommands = extractRunCommands(logs);

const parseResult = parseWorkflowLogs(logs, metadata, runCommands);
```

**Alternative** (simpler, doesn't require step tracking):
Scan log content for tool signatures:

```typescript
// Simple pattern-based detection from log content
const detectToolsFromLogs = (logs: string): string[] => {
  const tools: Set<string> = new Set();

  // Common tool output signatures
  if (/FAIL\s+.*\.test\.[jt]sx?/i.test(logs)) tools.add("vitest/jest");
  if (/RUN\s+v\d+\.\d+\.\d+/i.test(logs)) tools.add("vitest");  // Vitest banner
  if (/PASS\s+.*\.test\.[jt]sx?/i.test(logs)) tools.add("vitest/jest");
  if (/Test Suites:.*failed/i.test(logs)) tools.add("jest");

  return [...tools];
};
```

### Phase 5: Add to PR Comment

**File**: `apps/api/src/services/comment-formatter.ts`

Update `FormatCommentOptions`:

```typescript
export interface FormatCommentOptions {
  owner: string;
  repo: string;
  headSha: string;
  runs: WorkflowRunResult[];
  errors: ParsedError[];
  totalErrors: number;
  unsupportedTools?: string[];  // NEW
}
```

Add line to comment footer:

```typescript
export const formatResultsComment = (options: FormatCommentOptions): string | null => {
  // ... existing code ...

  // Footer with unsupported tools notice
  if (options.unsupportedTools && options.unsupportedTools.length > 0) {
    lines.push("");
    const toolList = options.unsupportedTools.join(", ");
    lines.push(`_Detected ${toolList} - parsers not yet available_`);
  }

  // ... rest of footer ...
};
```

### Phase 6: Add to Check Run Output

**File**: `apps/api/src/services/comment-formatter.ts`

Update `formatCheckRunOutput` similarly:

```typescript
// In the text section, add unsupported tools notice
if (options.unsupportedTools && options.unsupportedTools.length > 0) {
  textLines.push("");
  textLines.push(`_Note: Detected ${options.unsupportedTools.join(", ")} - no parser available yet_`);
}
```

## Detection Strategies

### Strategy A: Command-based (requires step tracking)
- Parse `##[group]Run npm run test` markers
- Detect tools from step commands
- Most accurate but requires step tracking implementation

### Strategy B: Log content-based (simpler)
- Scan log output for tool signatures
- "Test Suites:" → Jest
- "RUN v" banner → Vitest
- Less accurate but works immediately

### Strategy C: Hybrid
- Use both strategies
- Command-based when step tracking available
- Fall back to log content scanning

**Recommendation**: Start with Strategy B (log content), add Strategy A later.

## Log Content Detection Patterns

| Tool | Pattern | Example |
|------|---------|---------|
| Vitest | `RUN v\d+\.\d+` or `FAIL src/` | `RUN  v1.2.0 /path` |
| Jest | `Test Suites:` or `Tests:.*passed` | `Test Suites: 1 failed` |
| Mocha | `passing \(\d+` or `failing` | `5 passing (50ms)` |
| pytest | `PASSED` or `FAILED` with `::` | `test_foo.py::test_bar PASSED` |
| Prettier | `Checking formatting` | `Checking formatting...` |
| webpack | `webpack \d+\.\d+` | `webpack 5.88.0` |

## Files to Modify

1. `packages/parser/src/registry.ts` - Add tool patterns
2. `packages/parser/src/index.ts` - Export detection helpers
3. `apps/api/src/services/error-parser.ts` - Add detection to parse result
4. `apps/api/src/services/comment-formatter.ts` - Add to comment output
5. `apps/api/src/routes/webhooks.ts` - Pass unsupported tools through

## Testing

1. Create test workflow with vitest/jest
2. Verify tool is detected in logs
3. Verify notice appears in PR comment
4. Verify notice appears in check run output

## Future Enhancements

1. **Track detection stats** - Log which tools are detected for prioritizing parser development
2. **User feedback** - "Request parser for X" link
3. **Partial parsing** - Even without full parser, extract some info (pass/fail count)

## Estimated Effort

- Phase 1-2 (patterns + exports): 30 min
- Phase 3-4 (detection in parsing): 1 hour
- Phase 5-6 (comment formatting): 30 min
- Testing: 30 min
- **Total**: ~2.5 hours
