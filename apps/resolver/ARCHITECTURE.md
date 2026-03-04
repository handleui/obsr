# Resolver Service Architecture

The Resolver is a standalone Railway-deployed service that executes AI-powered resolving in isolated sandboxes. It consumes signed QStash queue events, dispatches queued resolve IDs, runs fixes using Claude/Codex, and returns patches.

## System Overview

```
+-------------+    logs    +------------------+   queue event  +------------------+
|             | ---------> |                  | -------------> |                  |
|   CI Run    |            |   Observer API   |                |     Resolver     |
|             |            |  (Cloudflare)    | <------------- |    (Railway)     |
+-------------+            |                  |     update     |                  |
      |                    +------------------+               +------------------+
      | extract errors            ^                                  |    |
      v (Claude Haiku)            |                                  |    | clone
+-------------+                   |                                  |    v
|  packages/  |                   |                           +------------------+
|   extract   |-------------------+                           |   Daytona Sandbox |
+-------------+      errors                                   |   (Ephemeral)    |
                                                              +------------------+
                                                                     ^
                                                                     | API calls
                                                                     v
                                                              +------------------+
                                                              |   AI Gateway     |
                                                              | (Claude/Codex)   |
                                                              +------------------+
```

### Two-Stage AI Pipeline

1. **Extraction (Claude Haiku)**: Parses raw CI logs to identify structured errors with file paths, line numbers, and messages
2. **Resolving (Claude/Codex)**: Receives pre-extracted errors and generates fixes in an isolated sandbox

## Resolve Execution Lifecycle

```
                         START
                           |
                           v
                   +----------------------+
                   | Receive Queue Event  |
                   | (signed by QStash)   |
                   +----------------------+
                           |
                           v
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
|                                              |   ResolveLoop    | |
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

1. **Queue Intake + Verification**
   - Validate Upstash JWT signature (issuer/body hash/subject)
   - Fail closed if QStash signing keys are missing
   - Accept only shared payload contract: `resolveId|resolveIds` + `source`

2. **Context Assembly**
   - Fetch project, organization, and run data from Convex/Postgres
   - Get GitHub installation token via App JWT
   - Build authenticated clone URL
   - Build compact resolver prompt context (`source`, `jobName`, `diagnostics[]`)
   - Format compact diagnostics into the resolver prompt

3. **Sandbox Setup** (timeout: 600s)
   - Create fresh E2B sandbox (`base` template)
   - Shallow clone repository with branch
   - Auto-detect package manager (bun/pnpm/yarn/npm)
   - Install dependencies

4. **Resolving Execution**
   - Initialize tool registry with sandbox adapters
   - Run `ResolveLoop` with system prompt and error context
   - Budget: $1.00 per run, 10 iterations max

5. **Patch Extraction**
   - Run `git diff` in sandbox
   - Capture changed file list via `git diff --name-only`

6. **Cleanup**
   - Always kill sandbox (in `finally` block)
   - Update resolve status with results or failure reason

## Daytona (Primary) + Legacy Providers

> **Provider status**: Daytona is the primary, idempotent sandbox provider. Vercel and E2B are retained for legacy compatibility.

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

## AI Resolving Loop Integration

The Resolver receives structured errors that have already been extracted from raw CI logs by Claude Haiku (see `packages/extract`). This separation allows fast, cost-effective extraction at ingestion time while reserving more capable models for the actual resolving process.

### Architecture

```
+------------------------------------------------------------------+
|                          ResolveLoop                                |
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
  runId: resolveId,
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

### Queue Payload Contract (Observer -> Resolver)

```typescript
type ResolverQueuePayload =
  | { resolveId: string; source: "create" | "trigger" }
  | { resolveIds: string[]; source: "create" | "trigger" };
```

### Resolver Prompt Context Contract (Worker Internal)

```typescript
interface ResolvePromptContext {
  source: string;
  jobName: string | null;
  diagnostics: Array<{
    message: string;
    filePath: string | null;
    line: number | null;
    column: number | null;
    ruleId: string | null;
    severity: "error" | "warning" | null;
    category: string | null;
  }>;
}
```

### Database Schema (resolves table)

| Column | Type | Description |
|--------|------|-------------|
| `id` | string | Resolve identifier |
| `type` | string | `'resolve'` for AI resolving |
| `status` | string | `pending` -> `running` -> `completed`/`failed` |
| `project_id` | string | FK to projects |
| `run_id` | string? | FK to runs (for error context) |
| `patch` | text? | Git diff output |
| `files_changed` | jsonb | Array of modified file paths |
| `resolve_result` | jsonb | Model info, verification status |
| `cost_usd` | integer | Cost in cents |
| `input_tokens` | integer | LLM input tokens |
| `output_tokens` | integer | LLM output tokens |
| `failed_reason` | text? | Error message on failure |

### Resolve Request Validation

```typescript
const resolveRequestSchema = z.object({
  resolveId: z.string().max(64).regex(/^[a-zA-Z0-9_\-./]+$/),
  repoUrl: z.string().max(2048).regex(GITHUB_REPO_URL_PATTERN),
  branch: z.string().max(256).regex(/^[a-zA-Z0-9_\-./]+$/),
  userPrompt: z.string().max(100_000),
  budgetPerRunUSD: z.number().positive().max(100).optional(),
  remainingMonthlyUSD: z.number().optional(),
});
```

### Response Format

```typescript
interface ResolveResponse {
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

1. **Stale Resolve Recovery**
   - On startup, mark resolves stuck >30 minutes as failed
   - Prevents orphaned `running` status

2. **Graceful Shutdown**
   - SIGTERM/SIGINT handlers
   - Wait for active resolves to complete
   - Close database pool

3. **Sandbox Cleanup**
   - Always kill sandbox in `finally` block
   - Log kill failures but don't throw

4. **Token Sanitization**
   - Scrub API keys from error messages
   - Patterns: `sk-ant-*`, `ghp_*`, `x-access-token:*`

### Concurrency Control

```
MAX_CONCURRENT_RESOLVES = 5
```

Active resolves are tracked in-memory. Queue deliveries are accepted only when slots are available.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 8080) |
| `MAX_CONCURRENT_RESOLVES` | No | Max in-memory concurrent resolves (default: 20, clamped to 1-100) |
| `SANDBOX_PROVIDER` | No | Sandbox provider (`daytona`, `vercel`, `e2b`), default: `daytona` |
| `DAYTONA_API_KEY` | No | Daytona API key (required if `SANDBOX_PROVIDER=daytona` and no JWT token is set) |
| `DAYTONA_API_URL` | No | Optional Daytona API URL override |
| `DAYTONA_TARGET` | No | Optional Daytona target override |
| `DAYTONA_ORGANIZATION_ID` | No | Optional Daytona organization ID when using JWT auth |
| `DAYTONA_JWT_TOKEN` | No | Optional Daytona JWT token (used with `DAYTONA_ORGANIZATION_ID`) |
| `E2B_API_KEY` | No | Legacy E2B API key (required if `SANDBOX_PROVIDER=e2b`) |
| `VERCEL_TOKEN` | No | Legacy Vercel token (required for `SANDBOX_PROVIDER=vercel`) |
| `VERCEL_TEAM_ID` | No | Legacy Vercel team ID (required for `SANDBOX_PROVIDER=vercel`) |
| `VERCEL_PROJECT_ID` | No | Legacy Vercel project ID (required for `SANDBOX_PROVIDER=vercel`) |
| `AI_GATEWAY_API_KEY` | Yes | AI Gateway access |
| `DATABASE_URL` | Yes | Postgres connection URL for run/error reads |
| `CONVEX_URL` | Yes | Convex deployment URL |
| `CONVEX_SERVICE_TOKEN` | Yes | Convex service token for authenticated access |
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | GitHub App private key (PEM) |
| `APP_BASE_URL` | No | App base URL for resolve links (defaults to `NAVIGATOR_BASE_URL`, then `https://detent.sh`) |
| `NAVIGATOR_BASE_URL` | No | Deprecated alias for `APP_BASE_URL` (fallback only) |
| `ENCRYPTION_KEY` | Yes | Base64 AES-GCM key for decrypting webhook secrets |

## Health Endpoints

- `GET /health` - Liveness probe
- `GET /ready` - Readiness probe
