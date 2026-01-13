---
"@detent/cli": minor
---

Add Sentry integration for CLI error tracking.
Lazy-loads SDK to avoid startup overhead, captures uncaught exceptions,
and flushes events before exit to ensure delivery.
