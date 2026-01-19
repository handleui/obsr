---
"@detent/healing": patch
---

Add structured error reporting to healing loop with error classification and context tracking.
Errors are now classified by type (rate limit, auth, timeout, etc.) with sanitized messages that remove API keys.
