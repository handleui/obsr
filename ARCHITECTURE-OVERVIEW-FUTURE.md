# Observer/Resolver Architecture (Simplified Product Direction)

## Goal
Unify the product into a two-service model with a minimal control surface:
- **Observer**: receives external events, normalizes CI failure context, and routes work.
- **Resolver**: executes fixes, tracks state, and publishes outcomes.

The system should feel deterministic in flow and opinionated in scope: one queue handoff, one executor path, and minimal orchestration layers.

## Behavior change (current direction)
1. Event sources (GitHub Actions, issue/comment signals, and future integrations) are collected in Observer.
2. For each actionable failure, Observer writes a compact record and enqueues a single fix job to Resolver.
3. Resolver claims the job, performs the fix attempt in isolation, and posts results back to the source context.
4. CLI and GitHub-native control flow remain the primary setup/interaction channel.
5. UI is optional and non-blocking for core automation.

## Diagnostic simplification strategy
We stop treating diagnostics as a standalone product layer.

- **Default path**: keep diagnostics **minimal and fast**.
  - Store: provider IDs, run metadata, failure signal, file/line hints when available, and concise confidence metadata.
  - Avoid deep multi-stage classification unless needed.
- **Enrichment path**: keep optional deep extraction as a feature flag.
  - Use only when confidence thresholds are too low or when the user explicitly enables richer analysis.

This keeps the system fast while preserving a path to higher precision.

## Target contract between Observer and Resolver
- Resolver receives a single payload shape per job containing:
  - canonical identifiers
  - run context
  - compact error signal
  - source links and raw log reference (always present)
- Resolver should be **idempotent by job id** and tolerant of repeated deliveries.
- Any richer diagnostics required later are derived from raw context, not re-required from a separate middle layer.

## Product simplification for maintainers
- Keep exactly two runtime services:
  - Observer (control/ingestion plane)
  - Resolver (execution plane)
- Do not add additional coordination workers unless there is explicit evidence of throughput or reliability bottlenecks.
- Keep setup in CLI + GitHub-driven operations; avoid adding mandatory new screens for core flows.

## Delivery roadmap
### v1.x (now)
- Stabilize the Observer→Resolver handoff.
- Preserve existing safety checks and operational visibility.
- Use minimal diagnostics as the default mode.

### v2.x (next)
- Make raw-path diagnostics the default for all CI-triggered events.
- Demote deep diagnostics to optional mode only.
- Expand queue trigger sources (deployment failures, PR reviewer comments, other CI providers) without introducing new runtime layers.

## Success criteria
- Lower time-to-trigger: fewer steps from event to resolver claim.
- Fewer moving parts in core path.
- No new service boundaries without clear scaling need.
- Maintainers can reason about the system from one ingestion path and one execution path.

## Open questions
- Which optional external sources should enter phase 1 of v2.x (besides CI failure and issue events)?
- What is the accepted minimum diagnostic payload for first-pass remediation?
- Which quality signals should auto-escalate from minimal mode to enrichment mode?
