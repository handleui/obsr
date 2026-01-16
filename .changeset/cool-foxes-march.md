---
"@detent/api": patch
---

Reorganize webhooks and GitHub services into modular directory structures.
Extracts webhook handlers into individual files under `routes/webhooks/handlers/` and splits GitHub API utilities into focused modules under `services/github/`.
