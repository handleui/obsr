---
"@detent/healer": patch
---

Remove VERCEL_OIDC_TOKEN environment variable support.
Vercel sandbox authentication now requires VERCEL_TOKEN with VERCEL_TEAM_ID and VERCEL_PROJECT_ID.
