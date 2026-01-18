---
"@detent/api": patch
---

Reflect actual CI state in GitHub App check run conclusion.
- Changed conclusion from "neutral" to "failure" when any CI job fails
- Added "skipped" conclusion when no valid CI-relevant workflows exist
- Added mintlify to workflow blacklist
