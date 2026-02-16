# SPEC-01: Convex Backend Optimization

## Summary
Fix polling architecture, unbounded queries, and missing server-side automation in Convex layer.

## Tasks

### 1. Replace HTTP polling with ConvexClient subscriptions
- **Where**: `apps/healer/src/poller/index.ts`
- **Problem**: Uses `ConvexHttpClient` polling every 5s (line 13). Wrong client type — only supports one-shot queries.
- **Fix**: Switch to `ConvexClient` (WebSocket). Use `client.onUpdate(api.heals.getPending, ...)` for reactive push.
- **Impact**: Eliminates 12 HTTP req/min, reduces heal pickup latency from 5s to near-instant.
- **Note**: Railway is long-lived process — persistent WebSocket is ideal.

### 2. Bound all `.collect()` calls
- **Where**: `convex/heals.ts`
- **Problem**: Several queries use `.collect()` without limits:
  - `getByPr` (line ~222) — PR with many heals grows unbounded
  - `getByProjectStatus` (line ~237) — unbounded
  - `getActiveByProject` (line ~254) — 4 separate `.collect()` calls
- **Fix**: Replace with `.take(N)` or `.paginate()` per Convex docs.
- **Validation**: Check all `.collect()` calls across entire `convex/` directory.

### 3. Use compound index for `getPending`
- **Where**: `convex/heals.ts`, `getPending` query (line ~291)
- **Problem**: Uses `by_status` index then filters `type` in JS application code.
- **Fix**: Use `by_status_type_updated_at` index when `args.type` is provided. Evaluate whether `by_status` index can be dropped entirely.

### 4. Move stale heal cleanup to Convex cron
- **Where**: `convex/crons.ts`, currently triggered from `apps/healer/src/poller/`
- **Problem**: `markStaleAsFailed` only runs on healer startup. If healer crashes, stale heals accumulate.
- **Fix**: Add `crons.interval("mark stale heals", { minutes: 5 }, internal.heals.markStaleAsFailed)`.
- **Prerequisite**: Ensure `markStaleAsFailed` is (or has) an `internalMutation` variant.

### 5. Add status transition guard in `updateStatus`
- **Where**: `convex/heals.ts`, `updateStatus` mutation (line ~299)
- **Problem**: Doesn't validate current status before transitioning. Two healer instances could claim same heal.
- **Fix**: Add `if (heal.status !== expectedCurrentStatus) return null` guard, especially for `pending → running`.

## Dependencies
- None. Fully self-contained in Convex + healer poller layer.

## Risk
- Task 1 (subscription switch) changes core polling loop — test thoroughly with multiple concurrent heals.
- Task 5 affects all status transitions — ensure CLI/API callers handle `null` return.
