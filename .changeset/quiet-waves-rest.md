---
"@detent/api": minor
---

- Optimize workflow run processing by storing passing runs without fetching logs
- BREAKING: Failed workflow runs now report `failure` conclusion instead of `neutral`
- Add "skipped" conclusion when no CI-relevant workflows are found
- Add mintlify to workflow blacklist
