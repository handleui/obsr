---
"@detent/navigator": patch
---

Fix health endpoint false degraded alerts caused by Vercel cold starts.
Removes cross-service API check that would timeout when both Navigator and API cold-started simultaneously.
Now checks only direct dependencies (WorkOS, Sentry) with proper timeout handling.
