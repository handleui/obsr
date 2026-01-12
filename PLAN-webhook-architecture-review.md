# Plan: Webhook Architecture Review & Future Improvements

## Current State

PR adds significant webhook processing functionality:
- **Run-aware idempotency**: `(runId, runAttempt)` tracking for re-runs
- **Bulk database operations**: Single transaction for all runs + errors
- **PR comment deduplication**: KV cache + DB persistence with locking
- **Check run lifecycle**: "queued" on `in_progress`, updated on `completed`
- **Rich annotations**: Severity mapping, titles, raw_details (max 50)
- **Stores ALL runs**: Not just failures, enabling future analytics

**Files changed**: 38 files, +11,327 / -588 lines

## Architecture Assessment

### Production-Ready (No Action Needed)

| Area | Implementation | Assessment |
|------|----------------|------------|
| Idempotency | KV locks + DB unique constraints | Excellent defense-in-depth |
| Race mitigation | Write-then-verify for KV eventual consistency | Industry standard |
| Bulk operations | Single DB connection, single transaction | Optimal for Workers |
| Concurrency | 3 concurrent log fetches (respects 6 TCP limit) | Memory-conscious |
| Fail-open | KV failures don't block processing | Resilient |
| PR comment lock | Prevents race conditions on same PR | Handles multi-commit |
| Stale lock recovery | 2-minute threshold for abandoned locks | Handles crashed workers |
| Input validation | Validates all GitHub data before storage | Defense-in-depth |
| Error sanitization | `sanitizeApiError()` prevents info leakage | Security-conscious |

### Future Improvements

## Issue 1: File Organization

**Problem**: `webhooks.ts` is 1,600+ lines with complex logic in one file.

**Current state**: Well-organized with helper functions and section comments. Works fine.

**Proposed structure**:
```
routes/webhooks/
├── index.ts              # Router + middleware
├── workflow-run.ts       # in_progress + completed handlers
├── installation.ts       # Installation event handlers
├── repository.ts         # Repository event handlers
├── organization.ts       # Organization event handlers
├── issue-comment.ts      # @detent command handling
├── helpers/
│   ├── validation.ts     # Input validation helpers
│   ├── sanitization.ts   # Error sanitization
│   └── pr-comments.ts    # Comment lifecycle helpers
```

**Implementation Steps**:
- [ ] Extract `handleWorkflowRunInProgress` and `handleWorkflowRunCompleted` to `workflow-run.ts`
- [ ] Extract validation helpers (`validatePositiveInt`, `truncateString`, `prepareRunData`)
- [ ] Extract PR comment helpers (`postOrUpdateComment`, `updateCommentToPassingState`)
- [ ] Extract installation/repository/organization handlers
- [ ] Update imports in `index.ts` router

**Priority**: Low (refactor when adding features, not blocking)

---

## Issue 2: Annotation Pagination

**Problem**: GitHub allows max 50 annotations per API request. Current code sends first 50 only.

**Impact**: Large error counts (>50) lose inline annotations for remaining errors.

**Current mitigation**: Errors sorted by priority score; most actionable shown first.

**Proposed solution**:
```typescript
// In finalizeAndPostResults(), after first updateCheckRun:
const allAnnotations = checkRunOutput.annotations ?? [];

if (allAnnotations.length > 50) {
  // First 50 already sent with summary/text
  // Send remaining in batches of 50 (annotations only)
  for (let i = 50; i < allAnnotations.length; i += 50) {
    await github.updateCheckRun(token, {
      owner,
      repo,
      checkRunId,
      status: "completed",
      conclusion: hasFailed ? "neutral" : "success",
      output: {
        title: checkRunOutput.title,
        summary: checkRunOutput.summary,
        annotations: allAnnotations.slice(i, i + 50),
      },
    });
  }
}
```

**Implementation Steps**:
- [ ] Add annotation batching loop in `finalizeAndPostResults`
- [ ] Add test for >50 errors scenario
- [ ] Consider rate limiting between batch calls

**Priority**: Medium (affects large error counts)

---

## Issue 3: GitHub API Rate Limit Queue

**Problem**: Installation token grants ~5,000 API calls/hour. Per workflow: ~5-10 calls. High-activity repos could approach limits during CI surges.

**Current mitigation**: Rate limit tracking with logging at <10% remaining. No queuing.

**Proposed solution**: Upstash-backed job queue for rate-limited retries.

```typescript
// New file: services/rate-limit-queue.ts
import { Redis } from "@upstash/redis";

interface QueuedWork {
  type: "check-run-update" | "pr-comment" | "log-fetch";
  payload: unknown;
  retryAfter: number; // Unix timestamp
}

const queueWork = async (redis: Redis, work: QueuedWork) => {
  await redis.zadd("detent:rate-limit-queue", {
    score: work.retryAfter,
    member: JSON.stringify(work),
  });
};

// Cron worker processes queue when rate limits reset
```

**Implementation Steps**:
- [ ] Add Upstash Redis binding to wrangler.jsonc (already have for rate limiting)
- [ ] Create rate-limit-queue service
- [ ] Add cron trigger to process queued work
- [ ] Modify GitHub service to queue on 429/rate limit errors

**Priority**: Low (monitor first, implement if hitting limits)

---

## Issue 4: Observability Metrics

**Problem**: No structured metrics for monitoring lock contention, duplicate processing, or rate limit consumption.

**Current state**: Console logs with prefixes (`[idempotency]`, `[pr-comment-lock]`).

**Proposed solution**: Add Sentry custom metrics or structured logging.

```typescript
// In idempotency.ts
if (!result.acquired) {
  Sentry.metrics.increment("lock.contention", 1, {
    tags: { lock_type: "commit" },
  });
}

// In webhooks.ts (duplicate detection)
if (allExist) {
  Sentry.metrics.increment("webhook.duplicate", 1, {
    tags: { reason: "all_runs_exist" },
  });
}
```

**Implementation Steps**:
- [ ] Add Sentry metrics for lock contention
- [ ] Add Sentry metrics for duplicate webhook detection
- [ ] Add Sentry metrics for rate limit warnings
- [ ] Create Sentry dashboard for webhook health

**Priority**: Medium (important for production monitoring)

---

## Issue 5: Lock TTL Edge Cases

**Problem**: Lock TTLs may be insufficient for very slow processing.
- Commit lock: 5 min TTL, 2 min stale threshold
- PR comment lock: 60s TTL, 30s stale threshold

**Current mitigation**: Stale lock recovery allows takeover.

**Potential improvement**: Dynamic TTL based on expected processing time.

```typescript
// Extend lock during long operations
const extendLock = async (kv: KVNamespace, key: string, lockId: string) => {
  const current = await kv.get<ProcessingState>(key, "json");
  if (current?.lockId === lockId) {
    await kv.put(key, JSON.stringify({ ...current, timestamp: Date.now() }), {
      expirationTtl: IDEMPOTENCY_TTL_SECONDS,
    });
  }
};

// Call periodically during long processing
```

**Implementation Steps**:
- [ ] Add lock extension helper
- [ ] Call during log fetching loop (every 60s)
- [ ] Add metrics for lock extensions

**Priority**: Low (current TTLs work for normal cases)

---

## Files Summary

| File | Current Lines | Concern |
|------|---------------|---------|
| `apps/api/src/routes/webhooks.ts` | 1,600+ | Could be split |
| `apps/api/src/services/idempotency.ts` | 500+ | Good, self-contained |
| `apps/api/src/services/comment-formatter.ts` | 700+ | Good, self-contained |
| `apps/api/src/services/github.ts` | 1,000+ | Could add queue integration |

## Testing Approach

### For Annotation Pagination
```typescript
// Test with 100+ errors
it("should paginate annotations beyond 50", async () => {
  const errors = Array.from({ length: 100 }, (_, i) => ({
    filePath: `file${i}.ts`,
    line: i,
    message: `Error ${i}`,
    severity: "error",
  }));
  // Verify multiple updateCheckRun calls
});
```

### For Rate Limit Queue
```typescript
it("should queue work when rate limited", async () => {
  // Mock GitHub API returning 429
  // Verify work is queued
  // Verify cron processes queue
});
```

## Monitoring Checklist (Post-Launch)

- [ ] Lock contention rates (grep for "Lost lock race")
- [ ] Duplicate processing frequency (grep for "already stored")
- [ ] GitHub API rate limit consumption (X-RateLimit headers)
- [ ] Processing latency P99 (Sentry traces)
- [ ] Memory usage during bulk operations

## Decisions Made

1. **Deploy now**: Architecture is production-ready
2. **Monitor first**: Implement rate limit queue only if hitting limits
3. **Refactor incrementally**: Split files when adding features
4. **Annotation pagination**: Medium priority, implement soon

## Verdict

**Ready for production.** The architecture is well-designed with multiple layers of deduplication (KV → DB unique constraint), proper handling of GitHub's eventual delivery semantics, and memory-conscious bulk operations.

Identified concerns are "nice to have" improvements for scale, not blockers. Recommend:
1. Deploy to production
2. Monitor metrics for 1-2 weeks
3. Implement annotation pagination if >50 errors is common
4. Implement rate limit queue if approaching limits
5. Refactor file organization when adding new features
