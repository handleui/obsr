---
"@detent/api": patch
---

Fix race condition where workflows weren't visible immediately after check_suite.requested.
Adds 3-second delay before fetching workflows and posts waiting comment from workflow_run
handler as fallback when check_suite fails to acquire the lock.
