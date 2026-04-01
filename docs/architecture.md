# Architecture

## Core Modules

- `observer-cli` (`apps/cli`)
- `observer-api` (`apps/api`)
- `resolver` (`apps/resolver`, legacy)

## observer-cli

- user auth/session management
- observe snapshot/watch workflows
- strict `json` / `ndjson` output envelopes
- prompt context generation for agents

## observer-api

- GitHub App webhook ingestion
- CI/build diagnostics normalization
- query by repo, PR, commit, run
- idempotent processing for duplicate deliveries

## resolver (legacy boundary)

- kept as optional sibling module
- not part of Observer core promise
