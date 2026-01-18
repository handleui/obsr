---
"@detent/api": minor
---

Add heals layer for autofix orchestration with Modal executor integration.

Introduces the `heals` table to track autofix and AI heal operations, organization settings for auto-commit behavior, KV-based deduplication locks, and a webhook endpoint for executor callbacks. Includes GitHub Data API integration for pushing commits directly to PR branches.
