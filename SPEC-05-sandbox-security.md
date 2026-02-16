# SPEC-05: Sandbox Security & Command Safety

## Summary
Harden sandbox boundary enforcement, command validation, and tool execution safety layer. These fixes apply regardless of sandbox provider (E2B legacy, Vercel primary).

## Tasks

### 1. Fix symlink traversal in path validation
- **Where**: `apps/healer/src/sandbox-tools.ts` (line ~89)
- **Problem**: Path validation uses string manipulation (`path.resolve`, prefix check) without filesystem stat. A symlink inside the worktree could point outside it, bypassing the boundary check.
- **Fix**: After string validation passes, resolve the real path via `fs.realpath()` (or sandbox equivalent) and re-check the prefix. If sandbox API doesn't support realpath, add `readlink` check for known symlink locations (`node_modules/.bin/`, etc.).
- **Fallback**: If realpath isn't available in sandbox, document the limitation and add to risk register.

### 2. Harden command pattern matching
- **Where**: `apps/healer/src/execute.ts` (line ~170)
- **Problem**: Normalizes commands then checks blocked patterns via string inclusion. Unusual whitespace, Unicode spaces, or encoded characters might bypass.
- **Fix**:
  - Normalize all whitespace (including Unicode `\u00A0`, `\u2003`, etc.) to ASCII space before checking.
  - Collapse multiple spaces to single space.
  - Reject commands containing non-ASCII characters entirely (no legitimate CI command needs them).
  - Blocked pattern check should use word boundaries where possible.
- **Note**: spawn-based execution already mitigates shell interpretation, but defense in depth matters.

### 3. Add blocked byte validation to file write paths
- **Where**: `apps/healer/src/sandbox-tools.ts`, file write operations
- **Problem**: File write tool validates path but may not check for null bytes (`\0`) in file content that could truncate writes in some runtimes.
- **Fix**: Scan file paths for null bytes (already done in extract's `related-files.ts` — reuse pattern). For file content, null bytes are legitimate in some files but flag if path ends in `.ts`, `.js`, `.json`, etc.

### 4. Rate-limit tool calls per heal
- **Where**: `packages/healing/src/tools/registry.ts`
- **Problem**: No per-tool rate limiting. A misbehaving model could call `run_command` hundreds of times in a single heal, consuming sandbox time.
- **Fix**: Add configurable per-tool call limits:
  ```ts
  const TOOL_CALL_LIMITS: Record<string, number> = {
    run_command: 100,
    write_file: 200,
    read_file: 500,
    list_directory: 200,
  };
  ```
- **Behavior**: After limit hit, tool returns error message telling model it's exceeded the limit. Don't abort entire heal — model may still produce a valid patch from existing context.

### 5. Validate sandbox network state
- **Where**: `apps/healer/src/heal-executor.ts`, post-install phase
- **Problem**: After dependency install, sandbox still has full network access. AI-generated code could exfiltrate repo contents or download malicious packages.
- **Fix**: If sandbox provider supports it, disable network after install phase. If not (E2B legacy limitation), document as known risk. For Vercel sandbox migration, ensure this is a first-class requirement.

### 6. Add command execution audit log
- **Where**: `apps/healer/src/execute.ts`
- **Problem**: Commands are executed but there's no structured audit trail. Hard to debug what happened during a heal, or detect abuse patterns.
- **Fix**: Emit structured log entry for every command:
  ```ts
  { tool: "run_command", command: normalized, exitCode, durationMs, outputBytes, step }
  ```
- **Store**: In heal metadata (Convex) for post-hoc analysis. Keep last N entries if storage is a concern.

## Dependencies
- Task 5 depends on sandbox provider capabilities — may be partial for E2B, full for Vercel.
- All others are independent.

## Risk
- Task 1 (symlink) may have false positives with `node_modules` symlinks in monorepos. Test with pnpm workspaces.
- Task 4 (rate limits) — limits too low will break legitimate heals. Start generous, tune from production data.
