---
"@detent/api": minor
---

Add error signature and occurrence tracking for cross-repo error analytics.
New database tables `error_signatures` and `error_occurrences` store deduplicated error patterns.
Errors are now fingerprinted on ingest and linked to signatures for historical tracking.
