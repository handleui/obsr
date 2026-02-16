# Finish Partial Spec Items — Validated Plan

## Corrections from Validation

- **Node.js spawn()** natively supports `options.signal` — no manual addEventListener needed
- **E2B sandbox.commands.run()** does NOT support per-command abort — pre-check only
- **`parsePartialJson`** lives in `@ai-sdk/ui-utils`, not `ai` — check if already a dep
- **GH Actions annotation regex** was incomplete — simplify to FILE_PATH_PATTERNS addition instead of parser
- **`continueOnInstallFailure`** flagged as YAGNI — no documented use case, skip
- **noiseRatio** has no consumer yet — add to HealResult alongside metric

---

## Batch 1 (Parallel — 4 subagents)

### 1A: AbortSignal in tool execution
**Files**: `packages/healing/src/tools/execute.ts`, `apps/healer/src/adapters/sandbox-tools.ts`
- `executeCommand`: pass `signal` to `spawn()` options natively (Node.js supports this). Remove/keep existing setTimeout as fallback for non-signal callers
- `executeSandboxCommand`: pre-check `signal?.aborted` before `sandbox.commands.run()` only (E2B has no cancel API)
- Clean up signal listener in finally block
- NOT wiring file read/write (no API support)

### 1B: GH Actions annotation → related-files
**Files**: `packages/extract/src/related-files.ts`
- Add ONE pattern to `FILE_PATH_PATTERNS`: `/::(?:error|warning)\s+file=([^,\s:]+)/gi`
- No parser needed — annotations already preserved as raw text for AI
- Test: annotation file paths extracted into related files list

### 1C: noiseRatio metric
**Files**: `packages/extract/src/preprocess.ts`, `packages/extract/src/types.ts`
- `filterNoiseLines`: track `removedCount`, return alongside filtered string
- `noiseRatio = removedCount / totalLines` in `prepareForPrompt`
- Add to `ExtractionMetrics` interface
- Skip `errorDensity` (requires error count from later pipeline stage)

### 1D: repairToolCall improvement
**Files**: `packages/healing/src/loop.ts`
- First: check if `@ai-sdk/ui-utils` is already in deps (`bun pm ls`)
- If yes: import `parsePartialJson`, replace hand-rolled regex, keep size guard
- If no: SKIP — current regex + JSON.parse validation is sufficient, not worth adding a dep

---

## Batch 2 (Parallel — 1 subagent)

### 2A: Audit log fields
**Files**: `packages/healing/src/tools/registry.ts`, `packages/healing/src/tools/types.ts`
- Extend `CommandLogEntry`: `command?: string`, `exitCode?: number`, `outputBytes?: number`
- `dispatch`: apply `redactSensitiveData()` to command string FIRST, then truncate to 200 chars
- Extract exitCode from `ToolResult.metadata` (already available in ExecuteMetadata)
- `outputBytes` = `result.output.length`

---

## Skipped (with justification)

| Item | Reason |
|------|--------|
| `continueOnInstallFailure` config | YAGNI — no documented use case for repos with intentionally broken installs |
| `errorDensity` metric | Circular dep — needs error count from extraction (later pipeline stage) |
| Sandbox network disable docs | Documentation-only, not code — follow-up issue |
| Shared null-byte utility | Over-engineering for `includes("\0")` |
| Structured annotation parser | Annotations already visible to AI as raw text; FILE_PATH_PATTERNS addition is sufficient |

---

## Open Questions

1. Is `@ai-sdk/ui-utils` already a dependency? (determines Task 1D scope)
