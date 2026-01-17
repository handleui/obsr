---
"@detent/api": minor
---

Add organization member management and background sync capabilities.

New features:
- GET/DELETE endpoints for managing org members with role-based access control
- Scheduled cron job (every 6 hours) to sync all orgs with GitHub state
- Organization webhook handler for member_added/member_removed cache invalidation
- Two-tier caching (in-memory + KV) for GitHub org member lists

Security improvements:
- Prevent information disclosure in role permission errors
- Validate WorkOS user ID format before database lookups
- Skip GitHub membership verification for existing members (trusts initial verification)
- Handle missing members:read permission gracefully with informative errors
