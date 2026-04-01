# Contracts

## Diagnostic Event Model

Canonical model fields:
- run metadata (`repo`, `pr`, `commit`, `run_id`, timestamps)
- normalized diagnostics (`id`, `source`, `severity`, `category`, `message`)
- optional snippets/hints (`file`, `line`, excerpt, remediation hint)

## CLI Contract

Stable command surfaces:
- `dt auth`
- `dt observe`
- `dt install`
- `dt settings`

Stable output modes:
- human-readable text
- `--json` envelope
- `--ndjson` event stream envelope

## API Contract

Self-host API supports:
- ingest of CI/build diagnostics
- query by repo/PR/commit/run
- webhook-driven updates for watch consumers
