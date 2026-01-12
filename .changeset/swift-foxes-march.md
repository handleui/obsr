---
"@detent/api": minor
---

Add organization settings as JSONB with configurable inline annotations and PR comments.
Settings can be managed via the API with proper role-based access (owner-only for auto-join,
admin/owner for annotations and comments). Webhook handlers now respect these settings with
an in-memory cache for performance.
