---
"@detent/api": minor
---

Add `@detent heal` command and move check runs to heal trigger time.
Check runs are no longer created automatically when CI starts. Instead, they are created when a user triggers healing via the `@detent heal` PR comment or dashboard. This reduces noise and gives users explicit control over when healing happens.
