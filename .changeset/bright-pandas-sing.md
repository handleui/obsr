---
"@detent/api": patch
---

Add Sentry error capture for health check failures and include latency tracking.
Failures are captured at warning level with proper fingerprinting for grouping.
