---
"@detent/api": minor
---

Add GitHub PR comment integration with CI error analysis.
Includes idempotent webhook handling that waits for all workflow runs to complete,
GitHub Check Run creation for visual status, and formatted error summaries on PRs.
Database schema extended with PR number and check run tracking.
