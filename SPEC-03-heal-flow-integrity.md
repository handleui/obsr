# SPEC-03: Heal Flow Data Integrity

## Summary
Fix race conditions, idempotency gaps, and budget timing issues across the heal lifecycle.

## Tasks

### 1. Prevent duplicate heal pickup across instances
- **Where**: `apps/healer/src/poller/index.ts` (line ~82), `convex/heals.ts`
- **Problem**: `activeHealIds` Set is in-memory — only deduplicates within one healer instance. Two Railway instances (or restarts during processing) can process the same heal concurrently.
- **Fix**: Two layers:
  1. Convex-side: Status transition guard (see SPEC-01 task 5) — `pending → running` must be atomic.
  2. Healer-side: After calling `updateStatus`, check return value. If `null`, skip (another instance claimed it).
- **Note**: The KV-based distributed lock for heal dedup already exists but only covers *creation*. Pickup needs same treatment.

### 2. Add idempotency to patch application
- **Where**: Heal apply flow (API → GitHub)
- **Problem**: If `apply` succeeds on GitHub (PR comment/commit posted) but the Convex status update to "applied" fails (network blip, timeout), a retry re-applies the patch. Duplicate PR comments, double commits.
- **Fix**: Add idempotency key to the heal record. Before applying, check if `appliedAt` is already set. Use GitHub's idempotency mechanisms where available (check for existing comment with heal ID before posting).

### 3. Fix budget check timing
- **Where**: `packages/healing/src/loop.ts` (line ~431)
- **Problem**: Budget limits checked AFTER `generateText()` completes. The `stopWhen` budget condition only fires on steps with tool results — a final text-only response bypasses it. Tokens already spent.
- **Current mitigation**: Post-hoc check on line 431 catches overspend but doesn't prevent it.
- **Fix**: Add budget check in `onStepFinish` callback (from SPEC-02 task 2). If budget exceeded, call `abortController.abort()` to stop before next step. This catches text-only steps too.
- **Depends on**: SPEC-02 task 2 (onStepFinish). Can implement independently with a simpler approach if needed.

### 4. Make dependency install failure fatal (configurable)
- **Where**: `apps/healer/src/heal-executor.ts` (line ~131)
- **Problem**: Install exit code != 0 logs warning, continues to healing. AI generates fixes against broken dependency state → false positive patches.
- **Fix**: Default to fatal. Add `continueOnInstallFailure: boolean` config option for repos that intentionally have broken installs (rare).
- **Record**: Store install exit code and stderr in heal metadata for debugging.

### 5. Add sandbox cleanup retry
- **Where**: `apps/healer/src/heal-executor.ts` (line ~312)
- **Problem**: If `sandbox.kill()` fails, resource leaks. No retry.
- **Fix**: Retry `sandbox.kill()` up to 3 times with 1s delay. Log but don't throw on final failure — the sandbox provider's TTL will eventually clean up.

### 6. Document E2B as legacy, Vercel as primary sandbox
- **Where**: Create note in `apps/healer/` README or inline comments
- **Problem**: E2B is currently the sandbox provider but Vercel is the primary going forward. E2B will return for enterprise tier.
- **Fix**: Add comments/docs marking E2B integration as legacy. Flag sandbox provider abstraction points for future Vercel migration. No code removal — just documentation.

## Dependencies
- Task 3 benefits from SPEC-02 task 2 but can be done independently.
- Task 1 pairs with SPEC-01 task 5 (Convex-side guard).

## Risk
- Task 2 (idempotency) touches GitHub integration — test with real PRs.
- Task 4 (fatal install) could break heals for repos with intentional install warnings — needs config escape hatch.
