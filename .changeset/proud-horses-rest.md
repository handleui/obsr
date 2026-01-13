---
"@detent/navigator": patch
---

Enhance health endpoint to verify actual service connectivity.
Now tests WorkOS API reachability and backend API health instead of only checking config presence.
Adds latency tracking and timeout handling for reliability.
