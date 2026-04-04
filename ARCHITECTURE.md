# Observer Architecture

## Overview

Observer is a CLI-first diagnostics product.

Primary flow:
1. Failures and context reach the product through authenticated APIs (e.g. issue ingest in `apps/obsr`), the CLI, or connectors — the MVP tree does not assume a separate GitHub App webhook service.
2. `@obsr/ai` provides the reusable OpenAI-first Responses runtime used by active AI workflows.
3. `apps/obsr` uses `@obsr/issues` to extract issue-native diagnostics and synthesize issue snapshots on top of that runtime.
4. The app stores normalized issues and diagnostics.
5. The CLI can orchestrate self-host (Docker Compose) and may grow streaming/query surfaces for agents.
6. Future solve workflows will consume stored issues downstream, not raw logs.

## Active Issue Pipeline

- `@obsr/ai` owns reusable Responses transport, routing, and error/runtime policy.
- `@obsr/issues` is the source of truth for extraction, normalization, and synthesis contracts.
- The active issue pipeline uses the official OpenAI SDK with the Responses API and structured `text.format` schemas.
- Vercel AI Gateway is optional routing infrastructure, not the domain abstraction.
- Future solving should live in a separate downstream domain package, not in `@obsr/issues`.

## Apps

- `apps/cli` — Observer CLI (`dt`, TypeScript/Bun)
- `apps/docs` — Documentation web surface
- `apps/obsr` — Observer web app (issue workflow)

## Responsibility Split

### Observer CLI
- Self-host: `dt create`, `dt start` (see [`docker/README.md`](docker/README.md))
- Future: auth/session, scope selection, machine-readable output for agents

### Observer web (`apps/obsr`)
- Auth, issue intake, AI-assisted extraction and synthesis
- Drizzle + Neon persistence for the MVP domain

## Data Boundary

- Privacy-first default behavior is required.
- Local-only and self-hosted workflows are first-class.
- Managed cloud is additive, not required.
