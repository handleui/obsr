# Architecture

## Core modules

- `observer-cli` (`apps/cli`, Rust `dt`)
- `observer-app` (`apps/obsr`, Next.js issue workflow)

## observer-cli

- Auth/session management where implemented
- Strict machine output where applicable
- Prompt context for agents

## observer-app

- Issue intake, extraction, and synthesis via `@obsr/issues` and `@obsr/ai`
- Drizzle + Neon persistence
