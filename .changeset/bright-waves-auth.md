---
"@detent/navigator": patch
---

Add sync-user API call during auth callback for faster org auto-join.
The call is non-blocking so auth flow continues even if sync fails.
