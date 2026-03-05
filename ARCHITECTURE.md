# Detent Architecture

## Overview

Detent is a self-resolving CI/CD platform with four main applications:

- `apps/observer` (Cloudflare Workers): API, auth, webhook ingestion, orchestration.
- `apps/resolver` (Railway): queue worker that runs AI resolving jobs in sandboxes.
- `apps/cli` (Bun/Node): local command-line interface (`dt`).
- `apps/web` (Next.js): product web surface.

Core runtime path is:

1. CI failure/event arrives in Observer.
2. Observer normalizes and stores run/error context.
3. Resolver claims queued work and attempts fixes in E2B sandboxes.
4. Results are reported back through Observer and surfaced to users.

## Service Responsibilities

### Observer (`apps/observer`)

- Auth and identity APIs.
- Organization/project APIs.
- Webhook processing and idempotency.
- Resolve request lifecycle and state transitions.
- Data persistence through `packages/db` (Neon + Drizzle).

### Resolver (`apps/resolver`)

- Polls and processes resolve jobs.
- Boots isolated sandboxes through `packages/sandbox`.
- Executes resolving loop from `packages/resolving`.
- Sends results/patches back to Observer APIs.

### CLI (`apps/cli`)

- Local interface for auth, linking, org/project actions, config, and errors.
- Uses Better Auth device authorization flow against Observer endpoints.
- Stores local state under `~/.detent` (prod) and `~/.detent-dev` (dev).
- Supports auto-update and signed binary distribution.

### Web (`apps/web`)

- Main product website and supporting web UX.
- Shares backend contracts with Observer.

## Shared Packages

- `packages/db`: schema, queries, migrations.
- `packages/sdk`: public API client used by CLI and external consumers.
- `packages/resolving`: agentic resolving logic.
- `packages/autofix`: deterministic non-agent fix paths.
- `packages/extract`: CI log parsing/extraction.
- `packages/git`, `packages/types`, `packages/sentry`, `packages/ai`, `packages/lore`, `packages/sandbox`, `packages/ui`.

## Data and Auth

- Primary database: Neon Postgres.
- Auth stack: Better Auth.
- API keys and bearer auth coexist for machine and user flows.

## Release Flow

### CLI

1. `release.yml` runs `release-please` on `main`.
2. If a CLI release is created, it emits a `cli-v*` tag.
3. `release.yml` dispatches `build.yml` with that tag and waits for completion.
4. `build.yml` builds binaries, signs checksums, uploads assets/blob artifacts, and publishes GitHub release artifacts.

### SDK

- When `release-please` creates an SDK release, `release.yml` builds and publishes `@detent/sdk` to npm.

## Local Development

Portless endpoints:

- Web: `http://detent.localhost:1355`
- Observer: `http://observer.localhost:1355`
- Resolver: `http://resolver.localhost:1355`

## Notes

- This document is intentionally concise and operational.
- Detailed implementation notes should live close to each app/package.
