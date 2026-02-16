# SPEC-02: AI SDK Healing Loop Modernization

## Summary
Adopt AI SDK v6 features the codebase misses. Improve timeout handling, observability, resilience, and memory.

## Tasks

### 1. Replace manual AbortController with SDK `timeout`
- **Where**: `packages/healing/src/loop.ts` (lines 383-387)
- **Problem**: Manual `AbortController` + `setTimeout` + `clearTimeout` in `finally`. No per-step timeout — a single hung LLM call consumes entire 10min budget.
- **Fix**: Use SDK's built-in `timeout` parameter:
  ```ts
  timeout: { totalMs: config.timeout, stepMs: 120_000 }
  ```
- **Keep**: External `abortSignal` for cancellation from outside (e.g., shutdown). Can pass both.

### 2. Add `onStepFinish` callback
- **Where**: `packages/healing/src/loop.ts`, `generateText()` call (~line 410)
- **Problem**: Verbose logging uses custom `setToolCallListener` pattern via tool registry. Cost tracking is post-hoc only.
- **Fix**: Add `onStepFinish` to `generateText()` options. Use it for:
  - Per-step verbose logging (tool calls, results, text)
  - Real-time cost accumulation via `totalUsage`
  - Step duration tracking
- **Note**: `onStepFinish` gives `text`, `toolCalls`, `toolResults`, `usage`, `totalUsage`, `finishReason`.
- **Keep**: `setToolCallListener` can coexist or be replaced — evaluate which is cleaner.

### 3. Propagate `abortSignal` to tool execution
- **Where**: `packages/healing/src/tools/registry.ts` (lines 90-104)
- **Problem**: Tool `execute` wrapper ignores second `options` parameter from SDK which contains `abortSignal`. Long-running `run_command` tools can't be cancelled cleanly.
- **Fix**: Accept `options` param, pass `options.abortSignal` through to `this.dispatch()`.
- **Prerequisite**: `dispatch` and downstream tool handlers must accept/respect `AbortSignal`.

### 4. Add `experimental_repairToolCall`
- **Where**: `packages/healing/src/loop.ts`, `generateText()` options
- **Problem**: When model generates invalid tool input JSON, the step fails and wastes an iteration of the 50-step budget.
- **Fix**: Add `experimental_repairToolCall` that attempts to fix malformed JSON before failing.
- **Scope**: Start simple — just re-parse with relaxed JSON. Don't over-engineer.

### 5. Reduce memory with `experimental_include`
- **Where**: `packages/healing/src/loop.ts`, `generateText()` options
- **Problem**: 50-step loop with file contents in tool results can accumulate significant memory. Full request/response bodies stored per step.
- **Fix**: `experimental_include: { requestBody: false }` — SDK docs: "When processing many large payloads, set requestBody to false to reduce memory usage."
- **Risk**: Low. Only affects what's stored on the response object, not what's sent to the API.

### 6. Clean up `ProviderOptions` type hack
- **Where**: `packages/ai/src/cache.ts` (line 10)
- **Problem**: `// HACK: Defined locally to avoid importing from @ai-sdk/provider which has version conflicts`
- **Fix**: With AI SDK v6 stable, try importing `ProviderOptions` from `@ai-sdk/provider` directly. If version conflict persists, document why and keep hack.

## Dependencies
- Task 3 has downstream impact on tool handler interfaces.
- All others are independent, can be done in parallel.

## Risk
- Task 1 changes timeout behavior — test with real heals to verify no regression.
- Task 4 is experimental API — pin to SDK version, add feature flag if needed.
