---
"@detent/api": major
---

Replace log-based parsing with JSON-based error collection.

Removes @detent/parser dependency entirely. Error parsing now happens at the source via the new GitHub Action, which sends structured JSON to the /report endpoint. This eliminates regex-based log parsing in favor of consuming native JSON output from CI tools (ESLint, Vitest, golangci-lint, Cargo, TypeScript).

Adds API key authentication (X-Detent-Token) for machine-to-machine communication and GitHub secrets encryption for automated token provisioning.
