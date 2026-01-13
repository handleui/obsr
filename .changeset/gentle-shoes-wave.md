---
"@detent/cli": patch
---

Fix unhandled rejection handler to properly await Sentry flush.
Prevents telemetry loss when the process exits after an unhandled promise rejection.
