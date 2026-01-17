---
"@detent/cli": minor
---

Redesign `dt link` command to mirror GitHub's repository structure.
Linking now verifies the project exists in Detent via the GitHub App installation
and stores project-level details (projectId, projectHandle) alongside org info.
Simplified status and unlink commands with cleaner output formatting.
