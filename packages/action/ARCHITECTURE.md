# GitHub Action Architecture

Client-side error collection and deterministic autofix for CI/CD pipelines.

## Overview

```
+------------------+     +----------------+     +----------------+
|  GitHub Action   | --> |  Detent API    | --> |  Healer (AI)   |
|  (this package)  |     |  (Cloudflare)  |     |  (Railway)     |
+------------------+     +----------------+     +----------------+
        |                        |                     |
   Deterministic            Stores data            AI-powered
   autofix only            Orchestrates           complex fixes
```

**This action handles deterministic fixes only.** Complex, AI-powered healing
runs in a separate Healer service on Railway with E2B sandboxes.

## Flow

```
GitHub Workflow
      |
      v
+------------------+
| 1. COLLECT       |  collect.ts - GitHub context, steps, matrix
+------------------+
      |
      v
+------------------+
| 2. DETECT        |  detect.ts - Find output files (JSON/text)
+------------------+
      |
      v
+------------------+
| 3. EXTRACT       |  AI extraction via @detent/extract or API
+------------------+
      |
      v
+------------------+
| 4. ENRICH        |  snippet.ts - Add code context
+------------------+
      |
      v
+------------------+
| 5. REPORT        |  report.ts - Send to API (retry + backoff)
+------------------+
      |
      v
+------------------+
| 6. AUTOFIX       |  autofix/* - Run allowlisted commands (PR only)
+------------------+
```

## Security Model

### Command Allowlist

Only pre-approved commands can execute. No dynamic command construction.

```typescript
// registry.ts
COMMAND_ALLOWLIST = [
  "biome check --write .",
  "eslint --fix .",
  "prettier --write .",
  "cargo clippy --fix --allow-dirty --allow-staged",
  "golangci-lint run --fix",
  "bun run fix",
  "npm run fix",
]
```

Commands not in this list are rejected with a warning.

### Path Traversal Prevention

```typescript
// executor.ts
isPathSafe(filePath) {
  - Rejects null bytes (\0)
  - Rejects absolute paths (/, C:)
  - Rejects directory traversal (.., .)
}
```

### SSRF Protection

API URL validation prevents internal network access:

```typescript
// index.ts
isPrivateHost() {
  - IPv4 loopback (127.0.0.1, localhost)
  - IPv6 loopback (::1)
  - IPv4-mapped IPv6 (::ffff:127.0.0.1)
  - Private ranges (10.*, 192.168.*, 172.16-31.*)
  - Link-local (169.254.*, fe80::)
  - Octal notation (0177.0.0.1)
  - Hex notation (0x7f.0.0.1)
}
```

### Token Handling

- Token marked as secret via `core.setSecret()`
- Transmitted via `X-Detent-Token` header
- Never logged or exposed in outputs

## AI Extraction

### Universal Extraction

Error extraction uses AI (Claude Haiku) instead of regex parsers. This approach:

- Works with any CI output format (ESLint, TypeScript, Vitest, Cargo, golangci, etc.)
- Handles new tools without code changes
- Adapts to format variations automatically

### Extraction Methods

```
CI Output
    |
    +-- @detent/extract (local)     # For direct package usage
    |
    +-- POST /v1/diagnostics (API)  # For GitHub Action
```

### Extracted Error Structure

```typescript
interface ParsedError {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  severity?: "error" | "warning";
  ruleId?: string;
  stackTrace?: string;
  suggestions?: string[];
  fixable?: boolean;
}
```

## Autofix Registry

### Priority-Based Execution

Higher priority runs first. Allows formatter-first ordering.

```typescript
AUTOFIX_REGISTRY = {
  biome:     { priority: 100 },  // Formatters first
  eslint:    { priority: 90 },
  prettier:  { priority: 80 },
  cargo:     { priority: 70 },   // Language-specific
  golangci:  { priority: 70 },
  "bun-fix": { priority: 60 },   // Package scripts last
  "npm-fix": { priority: 50 },
}
```

### Execution Flow

```
1. Get error sources from parsed errors
2. Filter to sources with autofix support
3. Sort by priority (descending)
4. For each config:
   a. Validate command in allowlist
   b. Execute with timeout (2 min)
   c. Capture git diff + changed files
   d. Report results to API
```

## Patch Handling

### Limits

| Limit            | Value  | Purpose                    |
| ---------------- | ------ | -------------------------- |
| MAX_PATCH_SIZE   | 1 MB   | Prevent huge diffs         |
| MAX_FILES_CHANGED| 100    | Bound scope of changes     |
| MAX_FILE_SIZE    | 10 MB  | Skip large files           |
| EXEC_TIMEOUT_MS  | 2 min  | Prevent hanging commands   |

### Truncation

When limits exceeded:
- Patch omitted, `truncated` flag set
- Files list capped at 100
- Warning logged to action output

### Binary Detection

```typescript
isBinaryContent(buffer) {
  // Check first 8KB for null bytes
  // Same heuristic as git
}
```

Binary files skipped with debug log.

## Error Classification

Maps HTTP status codes to actionable user guidance:

| Status | Code                | User Action                      |
| ------ | ------------------- | -------------------------------- |
| 401    | AUTH_MISSING_TOKEN  | Add DETENT_TOKEN secret          |
| 401    | AUTH_INVALID_TOKEN  | Regenerate token at detent.sh    |
| 404    | PROJECT_NOT_FOUND   | Install GitHub App               |
| 400/422| VALIDATION_ERROR    | Check output file format         |
| 429    | RATE_LIMITED        | Wait and retry                   |
| 5xx    | SERVER_ERROR        | Check status.detent.sh           |
| -      | NETWORK_ERROR       | Check firewall/connectivity      |

Errors written to:
1. PR checks annotation (title)
2. Warning annotations (suggestions)
3. Job summary (full troubleshooting)

## API Integration

### Endpoints

| Endpoint                 | Purpose                    |
| ------------------------ | -------------------------- |
| POST /report             | Submit workflow + errors   |
| POST /v1/heal/autofix-result | Submit fix results    |

### Retry Strategy

- Max retries: 3
- Exponential backoff: 1s, 2s, 4s (capped at 10s)
- Jitter: random 0-1s added
- Request timeout: 30s
- Transient errors (5xx, network) retry; client errors (4xx) fail fast

## File Structure

```
packages/action/
+-- src/
|   +-- index.ts          # Entry point, main flow
|   +-- collect.ts        # GitHub context collection
|   +-- detect.ts         # Output file detection
|   +-- report.ts         # API client with retry
|   +-- snippet.ts        # Code context extraction
|   +-- errors.ts         # Error classification
|   +-- parsers.ts        # AI extraction client
|   +-- autofix/
|       +-- registry.ts   # Command allowlist + config
|       +-- executor.ts   # Command execution + patching
+-- action.yml            # GitHub Action manifest
+-- dist/                 # Bundled output (ncc)
```

## Build

```bash
bun run build  # ncc bundle to dist/index.js
```

Single-file bundle includes all dependencies for GitHub Actions runtime.
