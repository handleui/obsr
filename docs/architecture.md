# Architecture

## Core modules

- `observer-cli` (`apps/cli`, TypeScript `dt`)
- `observer-app` (`apps/obsr`, Next.js issue workflow)

## observer-cli

- Self-host scaffolding: `dt create` (compose + env example), `dt start` (wraps `docker compose up`)
- Future: auth/session, machine-readable output, agent-facing workflows as the product grows

## observer-app

- Issue intake, extraction, and synthesis via `@obsr/issues` and `@obsr/ai`
- Drizzle + Neon persistence
