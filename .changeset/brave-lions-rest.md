---
"@detent/api": patch
---

Fix orphaned check runs when webhook processing fails early.
Retrieves stored check run ID before token retrieval and adds token recovery
logic in the error path to ensure cleanup can happen reliably.
