# Healing Package Architecture

The AI core of Detent. Orchestrates agentic error fixing using Claude models.

## Overview

```
+------------------+     +------------------+     +------------------+
|     Client       |---->|    HealLoop      |---->|   ToolRegistry   |
| (AI Gateway)     |     | (Orchestrator)   |     | (Tool Dispatch)  |
+------------------+     +------------------+     +------------------+
                               |    |
              +----------------+    +----------------+
              v                                      v
+------------------+                    +------------------+
|     Prompt       |                    |    Preflight     |
| (System + Format)|                    | (Error Validation)|
+------------------+                    +------------------+
```

## Module Structure

| Module | Purpose |
|--------|---------|
| `client.ts` | AI Gateway wrapper, model normalization, BYOK support |
| `loop.ts` | Agentic loop orchestration, budget enforcement, error handling |
| `tools/` | Tool registry and implementations (read, edit, grep, glob, run) |
| `prompt/` | System prompt and error formatting |
| `preflight/` | Error validation against current code state |
| `pricing.ts` | Token-to-USD cost calculation with cache-aware pricing |
| `eval/` | Evaluation framework (Braintrust tracing, scorers, datasets) |

## Error Classification System

Eight error types based on Anthropic API semantics:

| Type | HTTP Status | Retryable | Description |
|------|-------------|-----------|-------------|
| `TIMEOUT` | - | Yes | Request/response timeout |
| `RATE_LIMIT` | 429 | Yes (backoff) | Too many requests |
| `OVERLOADED` | 529 | Yes (backoff) | API capacity exceeded |
| `AUTH_ERROR` | 401, 403 | No | Invalid/insufficient credentials |
| `API_ERROR` | 500+ | Yes | Server-side errors |
| `TOOL_ERROR` | - | Depends | Tool execution failure |
| `VALIDATION_ERROR` | 400, 413, 422 | No | Invalid request/schema |
| `UNKNOWN` | - | - | Unclassified errors |

Classification priority: HTTP status > message patterns > tool context.

## Healing Loop Flow

```
                    +------------------+
                    |  Initialize      |
                    |  - Create result |
                    |  - Set timeout   |
                    +--------+---------+
                             |
                    +--------v---------+
                    |  generateText()  |<--+
                    |  (AI SDK call)   |   |
                    +--------+---------+   |
                             |             |
                    +--------v---------+   |
                    |  Process Step    |   |
                    |  - Execute tools |   |
                    |  - Track tokens  |   |
                    +--------+---------+   |
                             |             |
              +--------------+--------------+
              |              |              |
     +--------v----+  +------v------+  +----v--------+
     | Budget      |  | Max Steps   |  | Model Done  |
     | Exceeded?   |  | (50)?       |  | (no tools)? |
     +------+------+  +------+------+  +------+------+
            |                |                |
            | Yes            | Yes            | Yes
            v                v                v
      +-----------+    +-----------+    +-----------+
      | Stop:     |    | Stop:     |    | Stop:     |
      | budget    |    | max iter  |    | success   |
      +-----------+    +-----------+    +-----------+
```

**Constants:**
- `MAX_ITERATIONS = 50` (tool call rounds, not configurable)
- `MAX_TOKENS_PER_RESPONSE = 8192`
- `DEFAULT_TIMEOUT = 600_000ms` (10 minutes)

## Tool Registry Pattern

### Tool Interface

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  execute: (ctx: ToolContext, input: unknown) => Promise<ToolResult>;
}
```

### Registration and Dispatch

```
+-------------+     register()     +---------------+
|   Tool      | ------------------> |  ToolRegistry |
| Definitions |                     |               |
+-------------+                     | - tools: Map  |
                                    | - ctx         |
                                    | - listener    |
                    toAiTools()     +-------+-------+
+-------------+ <------------------ |       |
| AI SDK      |                     |       | dispatch(name, input)
| tool()      |                     |       v
+-------------+                     +---------------+
                                    |  Tool.execute |
                                    +---------------+
```

**Features:**
- Caches AI SDK conversion until new tools registered
- Tool call listener for verbose logging
- JSON Schema to Zod conversion (`schemaToZod`)
- Error wrapping with `errorResult()`

### Built-in Tools

| Tool | Purpose | Security |
|------|---------|----------|
| `read_file` | Read file contents | Path validation, symlink protection |
| `edit_file` | Apply targeted edits | Unique match requirement, path validation |
| `glob` | Find files by pattern | Within worktree only |
| `grep` | Search file contents | Within worktree only |
| `run_check` | Run CI category | Validates step commands |
| `run_command` | Execute shell commands | Safe list, blocked patterns, user approval |

## Budget Enforcement

Two budget layers with independent tracking:

```
                    +------------------+
                    |  HealConfig      |
                    | budgetPerRunUSD  |  Per-run limit (default $1.00)
                    | remainingMonthly |  Monthly quota (-1 = unlimited)
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
     +--------v--------+          +--------v--------+
     | Pre-step Check  |          | Post-run Check  |
     | (stopWhen)      |          | (validation)    |
     +-----------------+          +-----------------+
              |                             |
              v                             v
     +------------------+         +------------------+
     | Stop immediately |         | Set budgetExceed |
     | if projected >   |         | flag and reason  |
     | budget           |         +------------------+
     +------------------+
```

**Budget Exceeded Reasons:**
- `"per-run"` - Single heal exceeded budgetPerRunUSD
- `"monthly"` - Cumulative cost exceeded remainingMonthlyUSD

## Sanitization

Secrets are redacted before logging/storage to prevent leakage:

| Pattern | Replacement |
|---------|-------------|
| `sk-ant-*` | `[REDACTED_API_KEY]` |
| `sk-*` (OpenAI) | `[REDACTED_API_KEY]` |
| `gh[pousr]_*` | `[REDACTED_GITHUB_TOKEN]` |
| `github_pat_*` | `[REDACTED_GITHUB_PAT]` |
| `dtk_*` | `[REDACTED_DETENT_TOKEN]` |
| `Bearer *` | `Bearer [REDACTED_TOKEN]` |
| Generic secrets | `$1: [REDACTED]` |

**Note:** Shared utility at `@detent/types` has 50+ patterns. Local sanitization kept for specific replacement labels.

## Token Tracking

Cache-aware cost calculation:

```
+------------------+     +------------------+     +------------------+
| Input Tokens     | --> | Base Rate        | --> |                  |
| (standard)       |     | $X/M tokens      |     |                  |
+------------------+     +------------------+     |                  |
                                                  |   Total Cost     |
+------------------+     +------------------+     |   (USD)          |
| Cache Read       | --> | 0.1x Base Rate   | --> |                  |
| Tokens           |     |                  |     |                  |
+------------------+     +------------------+     |                  |
                                                  |                  |
+------------------+     +------------------+     |                  |
| Cache Write      | --> | 1.25x Base Rate  | --> |                  |
| Tokens (5m TTL)  |     |                  |     |                  |
+------------------+     +------------------+     |                  |
                                                  |                  |
+------------------+     +------------------+     |                  |
| Output Tokens    | --> | Output Rate      | --> |                  |
|                  |     | $Y/M tokens      |     |                  |
+------------------+     +------------------+     +------------------+
```

**Pricing (per million tokens):**

| Model | Input | Output |
|-------|-------|--------|
| Claude Opus 4.5 | $5.00 | $25.00 |
| Claude Sonnet 4.5 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $1.00 | $5.00 |
| Claude Sonnet 4 | $3.00 | $15.00 |
| Claude 3.5 Haiku | $0.80 | $4.00 |

## Preflight Validation

Validates errors against current code before healing:

```
+------------------+     +------------------+     +------------------+
| Extracted Errors | --> | validateErrors() | --> | PreflightResult  |
|                  |     |                  |     | - valid[]        |
|                  |     | For each error:  |     | - stale[]        |
+------------------+     | - Check file     |     +------------------+
                         | - Check line     |
                         | - Compare code   |
                         +------------------+
```

**Validation Reasons:**

| Reason | Description |
|--------|-------------|
| `file_missing` | Referenced file does not exist |
| `line_out_of_bounds` | Line number exceeds file length |
| `code_changed` | Code snippet no longer matches |

## Evaluation Subsystem

For development/testing only (devDependencies).

### Components

```
+------------------+     +------------------+     +------------------+
|  CostTracker     |     |  Scorers         |     |  Tracing         |
|  - task costs    |     |  - heuristic     |     |  - Braintrust    |
|  - judge costs   |     |  - LLM-as-judge  |     |  - spans/events  |
|  - budget check  |     |                  |     |                  |
+------------------+     +------------------+     +------------------+
```

### Heuristic Scorers

| Scorer | Weight | Description |
|--------|--------|-------------|
| `successScore` | 0.50 | Did healing succeed as expected? |
| `iterationEfficiencyScore` | 0.25 | Fewer iterations = better |
| `costEfficiencyScore` | 0.15 | Lower cost = better |
| `keywordPresenceScore` | 0.10 | Expected keywords in output |

### LLM-as-Judge Scorers

Uses Claude Haiku for cost efficiency:

| Scorer | Purpose |
|--------|---------|
| `fixCorrectnessScorer` | Does fix resolve the error? |
| `codeQualityScorer` | Is fix minimal and idiomatic? |
| `reasoningQualityScorer` | Did agent follow research-first workflow? |

**Security:** User content wrapped in `<user_content>` tags to prevent prompt injection.

### Cost Tracking

```typescript
const tracker = createCostTracker(maxBudgetUSD);
tracker.trackTaskCost(result.costUSD);    // HealLoop runs
tracker.trackJudgeCost(count, costPerCall); // LLM scorers
```

Default budget: $50/eval run (configurable via `EVAL_MAX_BUDGET_USD`).

### Braintrust Integration

Optional tracing when `BRAINTRUST_API_KEY` is set:

```typescript
initTracing();  // Initialize logger
const result = await tracedRun(
  { systemPrompt, userPrompt, model, budgetPerRunUSD },
  () => loop.run(systemPrompt, userPrompt),
  { testCaseId: 'ts-undefined-property' }
);
```

**Logged data:**
- Input (truncated, redacted)
- Output (success, final message)
- Metrics (iterations, tool calls, tokens, cost, duration)
- Metadata (model, budget, test case)

## System Prompt

Research-first workflow (improves accuracy significantly):

```
1. RESEARCH - Read error messages, find related files
2. UNDERSTAND - Identify root cause, not symptom
3. FIX - Make targeted edits, preserve style
4. VERIFY - Run run_check, iterate if needed
```

**Key constraints:**
- Always read file before editing
- Always verify after editing
- 2 attempts maximum (MAX_ATTEMPTS)
- Stack traces limited to 20 frames (MAX_STACK_TRACE_LINES)

## Command Execution Security

### Blocked Always

Commands: `rm`, `sudo`, `chmod`, `chown`, `curl`, `wget`, `ssh`, `scp`, `nc`, `eval`, `exec`, `sh`, `bash`, `zsh`

Patterns: `rm -rf`, `git push`, `git remote`, `|`, `&&`, `||`, `;`, `$(`, `` ` ``, `${`

### Safe List (No Approval Needed)

| Base Command | Allowed Subcommands |
|--------------|---------------------|
| `go` | build, test, fmt, vet, mod, generate, install, run |
| `npm` | install, ci, test, run |
| `cargo` | build, test, check, fmt, clippy, run |
| `bun` | install, test, run, x |
| `npx`, `bunx` | eslint, prettier, biome, tsc, vitest, jest, turbo |

### Environment Filtering

Only allowed vars pass through: `PATH`, `HOME`, `GOPATH`, `NODE_ENV`, etc.

Blocked suffixes: `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_CREDS`, `_AUTH`

## Public API

```typescript
// Core
export { Client } from "./client.js";
export { HealLoop, createConfig } from "./loop.js";

// Tools
export { createToolRegistry, ToolRegistry, getAllTools } from "./tools/index.js";

// Prompt
export { SYSTEM_PROMPT, formatErrors, formatErrorsWithHints } from "./prompt/index.js";

// Preflight
export { validateErrors, type PreflightResult } from "./preflight/index.js";

// Pricing
export { calculateCost } from "./pricing.js";

// Types
export type { HealConfig, HealResult, TokenUsage } from "./types.js";
```

## Typical Usage

```typescript
// 1. Create tool registry with context
const ctx = createToolContext(worktreePath, repoRoot, runId);
const registry = createToolRegistry(ctx);
registry.registerAll(getAllTools());

// 2. Configure and run
const config = createConfig(model, timeoutMins, budgetPerRunUSD, remainingMonthly);
const loop = new HealLoop(registry, config);

// 3. Execute healing
const result = await loop.run(SYSTEM_PROMPT, formattedErrors);

// 4. Check result
if (result.success) {
  // Apply patches from worktree
} else if (result.budgetExceeded) {
  // Handle budget limit
} else {
  // Handle failure with result.errorContext
}
```
