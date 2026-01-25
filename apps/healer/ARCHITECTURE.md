# Healer Service Architecture

The Healer is a standalone Railway-deployed service that executes AI-powered healing in isolated E2B sandboxes. It polls the API for pending heals, runs fixes using Claude, and returns patches.

## System Overview

```
+------------------+     poll      +------------------+     clone     +------------------+
|                  | <------------ |                  | ------------> |                  |
|   Detent API     |               |     Healer       |               |   E2B Sandbox    |
|  (Cloudflare)    | ------------> |    (Railway)     | <------------ |   (Ephemeral)    |
|                  |    update     |                  |     patch     |                  |
+------------------+               +------------------+               +------------------+
                                          |
                                          | API calls
                                          v
                                   +------------------+
                                   |   AI Gateway     |
                                   |  (Claude Sonnet) |
                                   +------------------+
```

## Heal Execution Lifecycle

```
                         START
                           |
                           v
                   +---------------+
                   | Poll Database |<-----------------+
                   | (5s interval) |                  |
                   +---------------+                  |
                           |                          |
                           | pending heals found      | no pending heals
                           v                          |
                   +---------------+                  |
                   | Mark 'running'|------------------+
                   +---------------+
                           |
                           v
+----------------------------------------------------------------+
|                     SANDBOX LIFECYCLE                          |
|                                                                |
|  +------------------+    +------------------+    +----------+  |
|  | Create Sandbox   |--->| Clone Repository |--->| Install  |  |
|  | (E2B base image) |    | (shallow clone)  |    | Deps     |  |
|  +------------------+    +------------------+    +----------+  |
|                                                       |        |
|                                                       v        |
|                                              +---------------+ |
|                                              |   HealLoop    | |
|                                              | (AI + Tools)  | |
|                                              +---------------+ |
|                                                       |        |
|                                                       v        |
|                                              +---------------+ |
|                                              | Extract Patch | |
|                                              |  (git diff)   | |
|                                              +---------------+ |
+----------------------------------------------------------------+
                           |
                           v
                   +---------------+
            +------| Update Status |------+
            |      +---------------+      |
            v                             v
    +-------------+               +-------------+
    | 'completed' |               |  'failed'   |
    | (with patch)|               | (with error)|
    +-------------+               +-------------+
```

### Phase Details

1. **Polling** (every 5 seconds)
   - Query `heals` table for `status='pending'` and `type='heal'`
   - Limit: `MAX_CONCURRENT_HEALS` (5) minus active heals
   - Order by `created_at ASC` (FIFO)

2. **Context Assembly**
   - Fetch project, organization, and run data
   - Get GitHub installation token via App JWT
   - Build authenticated clone URL
   - Format run errors into user prompt

3. **Sandbox Setup** (timeout: 600s)
   - Create fresh E2B sandbox (`base` template)
   - Shallow clone repository with branch
   - Auto-detect package manager (bun/pnpm/yarn/npm)
   - Install dependencies

4. **Healing Execution**
   - Initialize tool registry with sandbox adapters
   - Run `HealLoop` with system prompt and error context
   - Budget: $1.00 per run, 10 iterations max

5. **Patch Extraction**
   - Run `git diff` in sandbox
   - Capture changed file list via `git diff --name-only`

6. **Cleanup**
   - Always kill sandbox (in `finally` block)
   - Update heal status with results or failure reason

## E2B Sandbox Management

### Configuration

| Parameter | Value | Purpose |
|-----------|-------|---------|
| Template | `base` | Minimal Linux environment |
| Timeout | 600s | Per-sandbox lifetime |
| Clone Timeout | 120s | Git clone operation |
| Install Timeout | 300s | Dependency installation |
| Command Timeout | 300s | Per-command execution |

### Sandbox Service API

```typescript
interface SandboxService {
  create(opts?: SandboxOptions): Promise<Sandbox>
  connect(sandboxId: string): Promise<Sandbox>
  runCommand(sbx: Sandbox, cmd: string, opts?: RunCommandOptions): Promise<CommandResult>
  writeFile(sbx: Sandbox, path: string, content: string): Promise<void>
  readFile(sbx: Sandbox, path: string): Promise<string>
  kill(sbx: Sandbox): Promise<void>
}
```

### Security Constraints

- Path traversal prevention (`..` blocked)
- Sandbox ID format validation
- Error message truncation (200 chars max)
- Log truncation (10KB max)

## AI Healing Loop Integration

### Architecture

```
+------------------------------------------------------------------+
|                          HealLoop                                |
|                                                                  |
|  +------------+     +----------------+     +------------------+  |
|  |   Client   |---->|  generateText  |---->|   ToolRegistry   |  |
|  | (AI Gateway)|    |   (ai sdk)     |     | (sandbox tools)  |  |
|  +------------+     +----------------+     +------------------+  |
|                            |                       |             |
|                            v                       v             |
|                     +-------------+         +-------------+      |
|                     | Budget Stop |         | Tool Call   |      |
|                     | Condition   |         | Listener    |      |
|                     +-------------+         +-------------+      |
+------------------------------------------------------------------+
```

### Configuration

```typescript
const config = createConfig(
  "openai/gpt-5.2-codex",  // model
  10,                           // timeout (minutes)
  1.0,                          // budget per run (USD)
  -1                            // monthly budget (-1 = unlimited)
);
```

### Stop Conditions

1. **Step Count**: Max 50 iterations
2. **Budget**: Per-run ($1.00) or monthly limit
3. **Timeout**: 10 minutes default

### System Prompt Strategy

Research-first approach enforcing:
1. **RESEARCH** - Read errors, grep/glob for context
2. **UNDERSTAND** - Identify root cause
3. **FIX** - Targeted edits only
4. **VERIFY** - Run checks to confirm

## Tool Registry Pattern

### Registration Flow

```typescript
// Create context with sandbox reference
const toolContext = createSandboxToolContext({
  sandbox,
  worktreePath: WORKTREE_PATH,
  repoRoot: WORKTREE_PATH,
  runId: healId,
});

// Create registry and register tools
const registry = createToolRegistry(toolContext);
registry.registerAll(createSandboxTools(sandbox));

// Tools are converted to AI SDK format
const aiTools = registry.toAiTools();
```

### Available Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `read_file` | Read file with line numbers | `path`, `offset`, `limit` |
| `edit_file` | String replacement (unique match) | `path`, `old_string`, `new_string` |
| `glob` | Find files by pattern | `pattern`, `path` |
| `grep` | Search code with regex | `pattern`, `path`, `type` |
| `run_command` | Execute whitelisted commands | `command` |
| `run_check` | Re-run failing CI command | (none) |

### Command Allowlist

Pre-approved commands (no user approval needed):

```
go: build, test, fmt, vet, mod, generate, install, run
npm/yarn/pnpm/bun: install, test, run
cargo: build, test, check, fmt, clippy, run
python: -m (pytest, mypy, ruff, black, etc.)
Linters: eslint, prettier, biome, tsc
```

### Security Features

- Blocked commands: `rm`, `sudo`, `curl`, etc.
- Blocked patterns: pipes, redirects, variable expansion
- Path validation: no absolute paths, no `..` traversal
- Output limits: 50KB grep, 200 glob results

## API Communication Contract

### Database Schema (heals table)

| Column | Type | Description |
|--------|------|-------------|
| `id` | string | Heal identifier |
| `type` | string | `'heal'` for AI healing |
| `status` | string | `pending` -> `running` -> `completed`/`failed` |
| `project_id` | string | FK to projects |
| `run_id` | string? | FK to runs (for error context) |
| `patch` | text? | Git diff output |
| `files_changed` | jsonb | Array of modified file paths |
| `heal_result` | jsonb | Model info, verification status |
| `cost_usd` | integer | Cost in cents |
| `input_tokens` | integer | LLM input tokens |
| `output_tokens` | integer | LLM output tokens |
| `failed_reason` | text? | Error message on failure |

### Heal Request Validation

```typescript
const healRequestSchema = z.object({
  healId: z.string().max(64).regex(/^[a-zA-Z0-9_\-./]+$/),
  repoUrl: z.string().max(2048).regex(GITHUB_REPO_URL_PATTERN),
  branch: z.string().max(256).regex(/^[a-zA-Z0-9_\-./]+$/),
  userPrompt: z.string().max(100_000),
  budgetPerRunUSD: z.number().positive().max(100).optional(),
  remainingMonthlyUSD: z.number().optional(),
});
```

### Response Format

```typescript
interface HealResponse {
  success: boolean;
  patch: string | null;
  filesChanged: string[];
  result: {
    iterations: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    finalMessage: string;
  };
  error?: string;
}
```

## Error Handling and Recovery

### Error Classification

| Type | HTTP Status | Retryable | Action |
|------|-------------|-----------|--------|
| `RATE_LIMIT` | 429 | Yes | Backoff |
| `OVERLOADED` | 529 | Yes | Backoff |
| `AUTH_ERROR` | 401/403 | No | Fail |
| `API_ERROR` | 500+ | Yes | Retry |
| `TIMEOUT` | - | Yes | Retry |
| `TOOL_ERROR` | - | Depends | Log |
| `VALIDATION_ERROR` | 400/422 | No | Fail |

### Recovery Mechanisms

1. **Stale Heal Recovery**
   - On startup, mark heals stuck >30 minutes as failed
   - Prevents orphaned `running` status

2. **Graceful Shutdown**
   - SIGTERM/SIGINT handlers
   - Wait for active heals to complete
   - Close database pool

3. **Sandbox Cleanup**
   - Always kill sandbox in `finally` block
   - Log kill failures but don't throw

4. **Token Sanitization**
   - Scrub API keys from error messages
   - Patterns: `sk-ant-*`, `ghp_*`, `x-access-token:*`

### Concurrency Control

```
MAX_CONCURRENT_HEALS = 5
POLL_INTERVAL_MS = 5000
DB_POOL_SIZE = 5
```

Active heals tracked in-memory. New heals only fetched when slots available.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `SANDBOX_PROVIDER` | No | Sandbox provider (`vercel` or `e2b`, default: `vercel`) |
| `E2B_API_KEY` | No | E2B sandbox API key (required if `SANDBOX_PROVIDER=e2b`) |
| `VERCEL_TOKEN` | No | Vercel access token (required for Vercel Sandboxes) |
| `VERCEL_TEAM_ID` | No | Vercel team ID (required for Vercel Sandboxes) |
| `VERCEL_PROJECT_ID` | No | Vercel project ID (required for Vercel Sandboxes) |
| `AI_GATEWAY_API_KEY` | Yes | AI Gateway access |
| `DATABASE_URL` | Yes | Neon PostgreSQL connection |
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub App private key (PEM) |

## Health Endpoints

- `GET /health` - Liveness probe
- `GET /ready` - Readiness probe
