# Billing Implementation Audit: Error Extraction AI Cost Tracking

## Executive Summary

The proposed fix correctly identifies a critical gap: error extraction via Claude Haiku consumes tokens but those costs are completely untracked. The placement is sound, but the implementation has 6 ranked issues spanning error handling, field naming, scalability, and model tracking. This audit provides a prioritized roadmap with YAGNI flags where applicable.

---

## Ranked Issues & Recommendations

### **1. CRITICAL: Polar Field Name Bug (Fix Required)**
**Severity**: High | **YAGNI**: No | **Scope**: Breaking API contract

**Issue**:
`billing.ts:148-151` constructs Polar events with field name `name: "usage"`, but Polar SDK expects `eventName` (not `name`). Similarly, `metadata` field should be `properties`.

```typescript
// CURRENT (BROKEN)
ingestUsageEvents(polar, [
  {
    name: POLAR_EVENT_NAME,           // ❌ Should be 'eventName'
    externalCustomerId: orgId,
    metadata: buildPolarMetadata(usage), // ❌ Should be 'properties'
  },
])
```

**Evidence**:
- `polar.ts:11-13` defines `UsageEvent` interface with `name` field
- But Polar SDK docs (and `ingestUsageEvents` at line 99-106) shows the actual API payload uses different field names
- This suggests the wrapper is abstracting incorrectly OR the interface doesn't match the actual Polar API contract

**Impact**:
- Existing usage events may be silently dropping fields or failing validation
- Proposed AI usage tracking will inherit this bug
- Polar dashboard may show incomplete data

**Action**:
1. Verify actual Polar API schema (`@polar-sh/sdk` types)
2. Fix `UsageEvent` interface field names OR fix call sites
3. Add unit tests for Polar payload shape

**Blocking**: Yes — fix this before implementing AI tracking

---

### **2. CRITICAL: Unhandled Extraction Failure with Token Consumption (Design Issue)**
**Severity**: High | **YAGNI**: No | **Scope**: Billing accuracy

**Issue**:
The proposed code bills ONLY if `storeErrors()` succeeds AND returns `runRecordId`. But `extractErrors()` in line 284-287 of `error-extraction.ts` consumes tokens even if:
- Extraction times out
- Extraction fails after retries
- Log is empty/filtered (line 117-118 in `extract.ts` returns empty early, **with no usage data**)

```typescript
// CURRENT (in storeAndHealErrors, line 701-715)
const runRecordId = await storeErrors({...});
if (!runRecordId) {
  return; // ❌ If storeErrors fails, usage.costUsd is lost
}
// Usage billing only happens AFTER this point
```

Example failure scenario:
- Extraction uses 2000 input tokens + 500 output tokens = ~$0.001
- `storeErrors()` fails due to database connection error
- Cost is never recorded → revenue leak

**Root cause**:
`ExtractionResult` type (extract.ts lines 169-178) returns `usage` and `costUsd` regardless of success, but the error-extraction webhook handler doesn't look at these on empty/failed extractions.

**Impact**:
- Untracked AI costs when DB is unavailable
- No audit trail of failed extractions that consumed resources
- Harder to debug cost discrepancies

**Action**:
1. Move billing **before or alongside** `storeErrors()`, not after
2. Record usage even if extraction failed (use extraction.status as metadata)
3. Consider separate `recordFailedAIUsage()` path for failed/timed-out extractions

**Code change needed**:
```typescript
// In storeAndHealErrors, around line 700:
if (extraction.usage && extraction.costUsd != null) {
  await recordAIUsage(env, project.organizationId,
    runRecordId || `failed-${Date.now()}`, // Use temp ID if not stored
    { model: ..., costUSD: extraction.costUsd, ... },
    false
  );
}
```

**Blocking**: Moderately — shifts where billing happens

---

### **3. HIGH: Error Handling Strategy Undefined (Design Decision Needed)**
**Severity**: High | **YAGNI**: No | **Scope**: Reliability

**Issue**:
The proposal doesn't specify: if `recordAIUsage()` fails (e.g., Polar API outage, DB connection error), should it:
- **A) Block the entire extraction** (fail the webhook)
- **B) Fire-and-forget** with logging (current pattern in `recordUsage` at line 144-188)
- **C) Queue retry** (add to a failed-ingestion table)

Current `recordUsage()` uses pattern B: try to ingest to Polar, log error, continue. Retry is handled later by `retryFailedPolarIngestions()`.

**Evidence**:
- `billing.ts:144-188`: Polar ingestion failure is caught, logged, marked in DB as `polarIngested: false`
- `billing.ts:350-423`: Dedicated retry job to replay failed ingestions
- `error-extraction.ts:739-744`: Heal creation failure is silently logged, doesn't block

**Risk**:
- Pattern B (fire-and-forget) is correct for production resilience, but must be **explicitly chosen**
- If you pick A (blocking), webhook failures spike; if you pick C (queueing), you need infra

**Action**:
1. **Document the chosen strategy** in code comment
2. Apply consistently: all billings use same pattern (currently they do)
3. If keeping fire-and-forget: ensure failed ingestions have alerts/dashboards

**Blocking**: No — just needs clarity

---

### **4. HIGH: `occurredAt` Timestamp — YAGNI Check (Nice-to-have)**
**Severity**: Medium | **YAGNI**: Probably | **Scope**: Data quality

**Issue**:
Proposal suggests adding `occurredAt` field to Polar events. Current code doesn't send it; Polar likely defaults to ingest time.

```typescript
// Proposed addition (line ~149)
{
  name: POLAR_EVENT_NAME,
  externalCustomerId: orgId,
  metadata: buildPolarMetadata(usage),
  occurredAt: new Date(extraction.receivedAt ?? Date.now()).toISOString(),
}
```

**YAGNI Analysis**:
- ✓ Extraction happens ~instantly (in webhook), so `occurredAt` ≈ ingest time anyway
- ✓ Polar billing periods are typically daily/monthly, not second-precise
- ✗ Helps with audit trails if disputes arise (very rare for internal metering)
- ✗ Improves Polar analytics if you want per-second usage patterns

**Recommendation**: **Skip for now.** Add only if:
- Polar dashboard is showing anomalies due to ingest-time vs. event-time mismatch
- You need second-level precision for cost analysis

**Impact**: Low — purely cosmetic

---

### **5. MEDIUM: Model Name Tracking (Incomplete Observability)**
**Severity**: Medium | **YAGNI**: No | **Scope**: Ops/debugging

**Issue**:
The proposed code hardcodes `model: DEFAULT_FAST_MODEL` when recording AI usage. But:
- `extractErrors()` returns `usage` with NO model info (only tokens + cost)
- If you later switch models or add dynamic model selection, billing will show wrong model
- No way to trace: "this extraction cost $X and used model Y"

Current code flow:
```
extract.ts:180-218  → extractErrors() → buildUsage() → costUsd + no model name
                                           ↓
error-extraction.ts:284-287 → receives extraction (no modelId)
error-extraction.ts:683-745 → storeAndHealErrors() → hardcodes DEFAULT_FAST_MODEL
```

**Root cause**:
- `extractErrors()` receives `model?: string` option but doesn't return it in `ExtractionResult`
- `prep.modelId` is computed but discarded after `buildUsage()`

**Impact**:
- Breaks if you later want to bill different models differently
- Makes debugging "why did extraction cost more?" impossible
- Cost breakdown by model will be wrong

**Action**:
1. Add `model?: string` to `ExtractionResult` type
2. Return `modelId` from `extractErrors()` alongside `usage`
3. Pass it through to billing:
```typescript
if (extraction.usage && extraction.costUsd != null) {
  await recordAIUsage(env, project.organizationId, runRecordId, {
    model: extraction.model || DEFAULT_FAST_MODEL, // Use actual model
    inputTokens: extraction.usage.inputTokens,
    outputTokens: extraction.usage.outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUSD: extraction.costUsd,
  }, false);
}
```

**Blocking**: No — but needed for correctness long-term

---

### **6. MEDIUM: Granularity Mismatch (Empty Logs)**
**Severity**: Medium | **YAGNI**: Probably | **Scope**: Billing accuracy

**Issue**:
Extraction can consume tokens without extracting any errors:
- Log is only whitespace → `prepareExtraction()` returns `empty: true` (line 117-118)
- No usage data returned → cost = 0 (assumed, but not explicit)
- No billing record created

```typescript
// extract.ts:117-119
if (!prepared.trim() || FILTERED_ONLY_PATTERN.test(prepared)) {
  return { truncated, segmentsTruncated, segments, metrics, empty: true };
  // ↑ No usage field returned, so in extract.ts:213-218, usage is undefined
}
```

Then in `error-extraction.ts:808-810`:
```typescript
if (extraction.status !== "success" || extraction.errors.length === 0) {
  await storeEmptyExtraction(pipeline);
  return; // ✗ No billing for empty cases (correct? or a leak?)
}
```

**Ambiguity**:
- Is it correct to NOT bill for empty logs? (probably yes, no AI was used)
- Or should failed extractions bill? (extraction timed out = AI was used)

Current behavior: **Only successful extractions with ≥1 error are billed.** Failed/empty extractions = free.

**Recommendation**:
- **If empty/failed extractions use 0 tokens**: status quo is correct
- **If empty/failed extractions use tokens**: you need to bill them

Check `extract.ts:186-191` — if `prepareExtraction` returns `empty: true`, is the AI model ever called? **No** — the function returns early, so 0 cost is correct.

**Verdict**: **Not an issue.** The code is correct: AI not called → no cost.

---

### **7. MEDIUM: Byok Flag Handling (Audit Trail)**
**Severity**: Low | **YAGNI**: No | **Scope**: Compliance

**Issue**:
`recordAIUsage(..., byok: false)` is hardcoded in the proposal. But:
- `byok` (Bring Your Own Key) means the customer provided their own API key
- If `byok=true`, `recordUsage()` **returns early, never billing** (line 129-131)
- For error extraction, we always use `env.AI_GATEWAY_API_KEY` (line 286), so `byok=false` is correct

However, there's no way to trace in the future if extraction switches to customer-provided keys.

**Action**: Add a comment explaining why `byok=false` is hardcoded:
```typescript
// ↓ Error extraction always uses Detent's AI Gateway, never customer keys
await recordAIUsage(env, project.organizationId, runRecordId, {...}, false);
```

**Blocking**: No

---

## Summary Table

| Issue | Severity | YAGNI | Blocking | Type | Action |
|-------|----------|-------|----------|------|--------|
| 1. Polar field names | 🔴 HIGH | No | Yes | Bug | Fix SDK payload shape |
| 2. Failed extraction billing | 🔴 HIGH | No | Yes | Design | Bill before `storeErrors()` |
| 3. Error handling strategy | 🔴 HIGH | No | No | Design | Document chosen pattern |
| 4. `occurredAt` timestamp | 🟡 MEDIUM | **YES** | No | Nice-to-have | Skip for now |
| 5. Model name tracking | 🟡 MEDIUM | No | No | Ops | Return model from `extractErrors()` |
| 6. Granularity/empty logs | 🟡 MEDIUM | **YES** | No | Analysis | **Non-issue** — status quo correct |
| 7. Byok flag comment | 🟡 MEDIUM | No | No | Docs | Add clarifying comment |

---

## Implementation Order

1. **Fix Polar field names** (blocks everything else)
2. **Reorder billing to before/alongside `storeErrors()`** (correctness)
3. **Return model ID from `extractErrors()`** (observability)
4. **Document error handling strategy** (clarity)
5. **Add byok flag comment** (audit trail)
6. Skip `occurredAt` for now (YAGNI)
7. Skip granularity review (already correct)

---

## Files Affected

- **Break**: `apps/api/src/services/polar.ts` (field names)
- **Modify**: `apps/api/src/services/webhooks/error-extraction.ts` (billing placement, model tracking)
- **Modify**: `packages/extract/src/extract.ts` (return model ID)
- **Modify**: `apps/api/src/services/billing.ts` (none, reuse as-is)

---

## Questions for Design Review

1. Should failed extractions (timeout/error) that consumed tokens be billed? (Affects issue #2)
2. Keep fire-and-forget billing pattern with async retry, or change to blocking? (Affects issue #3)
3. Will error extraction ever use customer-provided API keys? (Affects issue #7)
