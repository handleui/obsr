# Contracts

## Diagnostic Event Model

Canonical model fields:
- run metadata (`repo`, `pr`, `commit`, `run_id`, timestamps)
- normalized diagnostics (`id`, `source`, `severity`, `category`, `message`)
- optional snippets/hints (`file`, `line`, excerpt, remediation hint)

## CLI Contract

Stable command surfaces (MVP):
- `dt create [dir]` — writes `compose.yaml` and `.env.selfhost.example` under the current working directory (paths cannot escape CWD)
- `dt start` — runs `docker compose up` (see `--file`, `--detach`, `--allow-outside` only if the compose path is outside CWD)

Additional output modes (e.g. `--json`, `--ndjson`) are reserved for future diagnostics workflows.

## API Contract

Self-host API supports:
- ingest of CI/build diagnostics
- query by repo/PR/commit/run
- webhook-driven updates for watch consumers
