# AI SDK Healing Loop Modernization Plan - Quality Audit

## Audit Findings Summary

Comprehensive review of 6-task plan to modernize HealLoop timeout, logging, tool propagation, and SDK features. This audit identifies critical edge cases, YAGNI violations, implementation risks, and missing considerations.

---

## 1. EDGE CASES & ERROR HANDLING ISSUES

### Task 1: Replace Manual Timeout with SDK `timeout`
**Critical Issue: Timeout Semantics Mismatch**
- Current code (line 383-387, loop.ts):
  - `abortController.abort()` → caught in catch block
  - Error classification checks `abortController.signal.aborted` (line 457)
- SDK `timeout` will throw a `TimeoutError` directly, NOT call `abort()` on passed `abortSignal`
- **Problem**: `abortController.signal.aborted` will be FALSE after SDK timeout, but code will still try to classify error
- **Risk**: Error classification logic breaks — timeout won't be detected correctly, may misclassify as "UNKNOWN" or "API_ERROR"
- **Solution Needed**: Catch `TimeoutError` explicitly OR change classification logic to check error type, not signal state

**Missing Detail**: What happens to partial tool call results when SDK times out mid-execution? No guidance on rollback/cleanup.

---

### Task 3: Propagate `abortSignal` to Tools
**Edge Case: Mid-Execution Abort**
- Current tool execute pattern (registry.ts line 94, read-file.ts line 139):
  - No `AbortSignal` awareness
  - Long-running ops like `readLinesFromFile` can't be interrupted mid-stream
- **Problem**: Tool receives abort signal, but:
  - File stream (read-file.ts line 80) won't close automatically
  - ripgrep process (grep.ts) won't be killed automatically
  - Build command (run-command.ts) won't be terminated
- **Risk**: Tools continue running after abort, consuming resources; streams/processes left open
- **Solution Approach**: Each tool needs:
  - Listener registration on `signal.addEventListener('abort', cleanup)`
  - Proper resource cleanup (rl.close(), process.kill(), etc.)
  - But plan doesn't detail this per-tool implementation

**Complexity**: Adding this requires changes to multiple tool implementations, not just interface.

---

### Task 4: `experimental_repairToolCall` JSON Cleanup
**Under-Engineered**: The plan mentions "trailing commas, single quotes → double quotes"
- **Risk**: Single-quote fix is overly simplistic
  ```json
  // Valid case: string containing single quote
  {"field": "it's"}  // Already valid, shouldn't match
  {"field": 'it\'s'} // Needs fixing

  // Edge case: escaped single quotes in JSON
  {"field": "escaped \'quote\'"} // Incorrectly transformed to double?
  ```
- **Risk**: Could corrupt JSON with escaped quotes or nested structures
- **Unknown**: Does "simple JSON cleanup" handle:
  - Missing commas between properties?
  - Incomplete objects (truncated by token limit)?
  - Nested objects with mixed quote styles?
- **Recommendation**: Define exact repair scope or use existing library (not home-grown regex)

---

### Task 2: `onStepFinish` Callback
**Unclear Intent**: Plan says "for per-step logging and iteration tracking"
- Current code already tracks iterations (line 389-425) via `response.steps`
- Already has per-tool logging via `setToolCallListener` (line 394-402)
- **YAGNI Risk**: What new information does `onStepFinish` provide?
  - Step timing? Not mentioned in plan or result struct
  - Token usage per step? Already aggregated post-call (line 72-111)
  - Tool call count per step? Already counted from response.steps (line 426-427)
- **Question**: Is this callback purely observational (telemetry) or does it enable new behavior?
- **Risk**: Adding unused callback bloats code without clear benefit

---

## 2. UNCLEAR / AMBIGUOUS STEPS

### Task 1: Timeout Configuration
**Ambiguity**: Plan says "Keep `abortSignal`"
- Does this mean:
  - Pass BOTH `timeout` config AND manual `abortSignal`? (redundant?)
  - Use SDK timeout but still call `clearTimeout(timeoutId)` in finally? (double cleanup)
  - Which takes precedence if both fire? (undefined behavior)
- **Recommendation**: Clarify whether to remove manual timeout entirely or dual-control

### Task 3: Tool Interface Update
**Ambiguity**: "Update `Tool` interface to accept optional `AbortSignal`. Existing tools don't need changes."
- This is contradictory:
  - If interface changes from `execute(ctx, input)` to `execute(ctx, input, options?)`, it's a breaking change
  - Existing tools **will** break unless made backward compatible
  - Plan suggests no changes to tools (8 files), but interface change affects all
- **Recommendation**: Clarify whether this is:
  - Truly optional (tools can ignore signal): `execute: (ctx, input, opts?) => ...`
  - Or required structural change that demands tool updates

### Task 6: Type Import
**Vague**: "Replace local `ProviderOptions` type hack with import from `ai` package"
- Grep found NO usage of `ProviderOptions` in healing package
- **Question**: Where is this type currently used or defined as a hack?
- **Risk**: Plan references non-existent code or wrong location

---

## 3. YAGNI VIOLATIONS

### Task 2: `onStepFinish` Callback — Unnecessary?
**Current State**:
- `response.steps` already provides iteration count (line 424)
- `setToolCallListener` already logs tools (line 394)
- Token usage already tracked per-step in `response.steps[].usage` (line 89-111)
- **Burden**: Adding callback requires:
  - Registry modification to invoke callback
  - Loop.ts code to consume callback (no consuming code shown in plan)
  - Potential memory overhead if callback stores all steps
- **Ask Before Proceeding**: What observability gap does `onStepFinish` fill that isn't served by existing `response.steps` + `setToolCallListener`?

### Task 5: `experimental_include: { requestBody: false }`
**Premature Optimization**:
- Plan mentions "reduce memory"
- **Question**: How much memory? Is this a real bottleneck?
- Current request body size:
  - System prompt: ~2KB (cached with prompt cache)
  - User prompt: ~5-10KB typical
  - Tool outputs: ~20-50KB per step (accumulated)
  - Total: Usually <500KB per run
- **Risk**: Removing request body disables SDK debugging/logging
- **Recommendation**: Benchmark memory impact before implementing. May be YAGNI.

### Task 1: `stepMs: 120_000` (2-minute step timeout)
**Arbitrary?**:
- Plan sets `{ totalMs: config.timeout, stepMs: 120_000 }`
- Where does 120s come from? Not explained
- **Current step behaviors**:
  - Tool execution: typically 1-30s (file I/O, ripgrep, build commands)
  - LLM response generation: typically 5-60s
  - Tool-heavy loops: can exceed 120s if tool fails + retries
- **Risk**: 120s is too short and will cause unnecessary cancellations mid-iteration
- **Recommendation**: Justify this value or make it configurable

---

## 4. BETTER ALTERNATIVES

### Instead of Manual `experimental_repairToolCall`:
- Use `parsePartialJson()` from `ai` package (built-in, tested, handles edge cases)
- Already available in AI SDK 6.x
- **Plan assumes home-grown solution; SDK has this**

### Instead of `onStepFinish` for Observability:
- Leverage `response.steps` directly in loop (already available)
- Add optional metadata field to HealResult if new metrics needed
- Avoids callback complexity

### Instead of Timeout + AbortSignal Dual Control:
- Remove manual setTimeout entirely
- Let SDK manage timeout via `timeout: { totalMs, stepMs }`
- Simplifies finally block, clearer error semantics
- **Current approach mixes two timeout mechanisms**

---

## 5. RISK ASSESSMENT (High to Low)

### 🔴 HIGHEST RISK
1. **Task 1 + Error Classification Interaction** (Task 1)
   - Timeout semantics change breaks error classification logic
   - Affects all error reporting, monitoring, retry behavior
   - Blast radius: Error handling, logging, dashboards
   - Requires: Refactor error classification to catch TimeoutError, not check signal state

2. **Tool Abort Propagation Complexity** (Task 3)
   - Plan undershoots implementation work
   - Each tool needs explicit abort handling
   - Incomplete tool cleanup = resource leaks in sandbox
   - Blast radius: E2B sandbox stability, cost escalation
   - Requires: Per-tool audit + implementation (not just interface change)

### 🟠 MEDIUM RISK
3. **JSON Repair Under-Specification** (Task 4)
   - Naive regex could corrupt valid JSON
   - Edge cases with escaped quotes, nested structures
   - Blast radius: Healing failures on valid-but-malformed model output
   - Requires: Clear repair rules or library choice

4. **Dual Timeout Mechanism Confusion** (Task 1)
   - Manual timeout + SDK timeout = ambiguous behavior
   - Error handling logic unclear
   - Blast radius: Timeout handling inconsistency
   - Requires: Decide on single source of truth

### 🟡 LOW-MEDIUM RISK
5. **Interface Breaking Change** (Task 3)
   - Tool interface change contradicts "no tool changes" statement
   - Could break if AbortSignal not truly optional
   - Blast radius: All 8 tool implementations
   - Requires: Clarify optional vs. required

6. **Unclear Type Hack Reference** (Task 6)
   - Plan references non-existent code location
   - Low impact if truly missing (skip task)
   - Blast radius: Minimal if not actually used

### 🟢 LOWEST RISK / YAGNI
7. **Premature Memory Optimization** (Task 5)
   - requestBody = false is nice-to-have, not critical
   - Trade-off: Loss of debugging data
   - Blast radius: Debugging capability only
   - Recommendation: Defer until memory is proven bottleneck

8. **Observability Callback** (Task 2)
   - Overlaps with existing mechanisms
   - Low impact if just telemetry
   - Blast radius: Observational only
   - Recommendation: Validate consumer exists or skip

---

## 6. IMPLEMENTATION CONCERNS

### Missing Implementation Details:
- **Task 1**: How to refactor `classifyError` to handle TimeoutError vs. aborted signal
- **Task 3**: Which tools need abort handling? How to safely close file streams, kill processes?
- **Task 4**: JSON repair algorithm (regex pattern or library)
- **Task 2**: Where does `onStepFinish` callback get wired in registry? What does consumer code look like?
- **Task 6**: Location of current "type hack" (not found in codebase)

### Testing Gaps:
- Error classification under timeout (Task 1) needs new test cases
- Tool abort propagation (Task 3) needs sandbox integration test
- JSON repair edge cases (Task 4) need corpus of malformed JSON from LLM
- No mention of how to validate these changes don't break existing healing flows

---

## 7. QUESTIONS BEFORE PROCEEDING

1. **Task 1**: Does SDK `timeout` throw `TimeoutError` or use passed `abortSignal`? Clarify so error classification works.
2. **Task 3**: Is adding AbortSignal to Tool interface a breaking change? Need backward compatibility strategy.
3. **Task 4**: What's the exact JSON repair scope? Use `parsePartialJson()` or home-grown fix?
4. **Task 2**: What observability gap does `onStepFinish` fill that `response.steps` doesn't?
5. **Task 5**: What's the baseline memory usage before optimization? Is requestBody removal justified?
6. **Task 1**: Where does `stepMs: 120_000` come from? Justify or make configurable.
7. **Task 6**: Where is the current "ProviderOptions type hack"? (Not found in grep)

---

## RANKED IMPROVEMENTS (Priority Order)

### Must Fix:
1. **Resolve timeout + error classification conflict** (Task 1)
   - Refactor classifyError to catch TimeoutError explicitly
   - Remove manual setTimeout if using SDK timeout
   - Add test for timeout → TIMEOUT classification

2. **Specify tool abort implementation strategy** (Task 3)
   - Audit which tools need abort handling
   - Define per-tool cleanup logic
   - Make AbortSignal truly optional in interface or document breaking change

3. **Define JSON repair scope precisely** (Task 4)
   - Choose library (parsePartialJson) vs. regex
   - Document edge cases it handles/doesn't handle
   - Add test corpus from real LLM output

### Should Fix:
4. **Clarify onStepFinish purpose & consumer** (Task 2)
   - Validate that callback adds observability not already in response.steps
   - Show consumer code or defer task

5. **Verify requestBody optimization value** (Task 5)
   - Benchmark memory impact before changing (YAGNI until proven)
   - Consider loss of debugging capability

### Could Defer / Clarify:
6. **Find and fix ProviderOptions type hack** (Task 6)
   - Grep found nothing; may not exist or be misnamed
   - Lower priority if import not urgent

---

## SUMMARY FOR PLAN AUTHOR

**Verdict**: Plan is directionally sound but **missing critical implementation details** that would cause failures if executed as-is.

- **Task 1 & Error Classification**: Highest risk. Timeout semantics change breaks error handling without refactoring classifyError logic.
- **Task 3 & Tool Abort**: Underestimates implementation scope. Per-tool abort handling not detailed.
- **Task 4 & JSON Repair**: Under-specified. Needs algorithm definition or library choice.
- **Tasks 2, 5**: YAGNI risk. Validate observability gap and memory impact before proceeding.
- **Task 6**: Reference error. Cannot find "ProviderOptions type hack" in codebase.

**Recommended Action**: Resolve the 7 questions above, then refactor plan with:
- Explicit error classification refactoring for Task 1
- Per-tool abort audit for Task 3
- JSON repair algorithm spec for Task 4
- Consumer code for Task 2 or defer
- Memory baseline for Task 5
- Located type hack for Task 6

**Estimated Effort Adjustment**: Plan likely underestimated Task 3 (tool abort propagation) by 2-3x. Task 1 needs error classification rework (not just timeout swap).

