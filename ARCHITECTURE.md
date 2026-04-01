# Observer Architecture

## Overview

Observer is a CLI-first diagnostics product.

Primary flow:
1. GitHub App webhooks deliver CI/build events to API.
2. API normalizes and stores diagnostics.
3. CLI queries and streams diagnostics for humans and coding agents.
4. Agents use output to fix code locally.

## Apps

- `apps/api` — Observer API service (Cloudflare Workers)
- `apps/cli` — Observer CLI (`dt`)
- `apps/web` — Product/docs web surface
- `apps/resolver` — Legacy sibling module (optional)

## Responsibility Split

### Observer CLI
- Auth/session management
- Scope selection (`repo`, `pr`, `commit`, `run`)
- Human output and strict machine output (`json`, `ndjson`)
- Agent-facing prompt context generation

### Observer API
- GitHub App webhook ingestion
- CI/build diagnostics extraction and normalization
- Query APIs for commit/PR/run diagnostics
- Idempotency and reliability controls
- Self-host deployment target

### Resolver (Legacy)
- AI patch generation and application workflows
- Not required for Observer diagnostics workflows

## Data Boundary

- Privacy-first default behavior is required.
- Local-only and self-hosted workflows are first-class.
- Managed cloud is additive, not required.
