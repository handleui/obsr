# Privacy and Ops

Storage modes:
- local-first workflows
- self-host API for retention and team scale

Policy defaults:
- minimal payload storage
- redact secrets before persistence
- redact secrets in CLI output

Ops defaults to define in deployment config:
- retention TTL for raw logs
- retention TTL for normalized diagnostics
- idempotent webhook delivery handling
