# Observer

Observer is a diagnostics hub for coding agents and humans.

Core value:
- ingest CI/build failures
- normalize diagnostics
- explain failures in plain language
- output copy-ready context for Codex, Cursor, and Claude Code

What Observer is not:
- not a Datadog or Sentry replacement
- not a full traces/metrics platform
- not resolver-first

Product stance:
- CLI first
- self-host API first
- managed cloud is optional later

Resolver stays in this repo as a legacy sibling module, not the core product.
