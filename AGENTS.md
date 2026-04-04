# Observer

Diagnostics hub for coding agents and humans: ingest failures, normalize diagnostics, and produce agent-ready context. Downstream “solve” workflows are out of scope for the core product; see root [`README.md`](README.md).

## Commands

```bash
bun run build                 # Build all (Turborepo)
bun run lint                  # Check issues
bun run fix                   # Auto-fix with Biome
bun run check-types           # TypeScript validation
bun run test                  # All package tests (Turborepo)
bun run check:legacy-imports  # Fails if forbidden legacy-type imports appear
bun run dt -- <command>       # CLI (TypeScript); subcommands: create, start
cd apps/obsr && npx auth generate --output ./src/db/auth-schema.ts --adapter drizzle --dialect postgresql --yes
cd apps/obsr && bun run db:generate    # Generate Drizzle SQL migration files
cd apps/obsr && bun run db:migrate     # Apply Drizzle migrations
```

## Tech Stack

- **Runtime**: Bun, Node >=18
- **Monorepo**: Turborepo
- **Active App**: Next.js 16, React 19, Tailwind CSS (`apps/obsr`)
- **Docs**: Next.js 16 docs site (`apps/docs`)
- **Database**: Neon Postgres (Drizzle)
- **CLI**: TypeScript/Bun + Citty (`apps/cli`, `dt`) — `create` / `start` for self-host scaffold
- **AI**: Claude Haiku 4.5 (`anthropic/claude-haiku-4-5`, fast) + GPT-5.2 Codex (`openai/gpt-5.2-codex`, smart) via Vercel AI Gateway — model routing in `packages/ai`, issue extraction/synthesis via OpenAI Responses API in `packages/issues`
- **Linting**: Biome via Ultracite
- **Icons**: `iconoir-react` — browse at [iconoir.com](https://iconoir.com). Do NOT grep `node_modules`.

## Project Structure

```
apps/
├── cli/            # CLI (dt): self-host compose helpers
├── docs/           # Documentation app (Next.js)
└── obsr/           # Observer MVP app (Next.js)

docker/
└── compose.yaml    # Postgres + Observer image (self-host)

packages/
├── ai/             # OpenAI Responses transport (thin; no issue domain logic)
├── issues/         # Issue-domain contracts + Responses-based extraction/synthesis
├── types/          # Cross-cutting primitives (sanitize, etc.)
├── ui/             # Shared React components
└── typescript-config/
```

## Database

Active Observer data lives in `apps/obsr`.

- **Observer MVP business tables**: `apps/obsr/src/db/schema.ts`
- **Observer MVP auth tables**: `apps/obsr/src/db/auth-schema.ts`
- **Migration system**: Drizzle only. Better Auth CLI generates auth schema; Drizzle Kit generates/applies SQL migrations.

### Intended DB Flows

- **Business schema only changed**: `cd apps/obsr && bun run db:generate`
- **Better Auth config/plugins changed**: `cd apps/obsr && npx auth generate --output ./src/db/auth-schema.ts --adapter drizzle --dialect postgresql --yes && bun run db:generate`
- **Apply generated migrations**: `cd apps/obsr && bun run db:migrate`

## Rules

- IMPORTANT: Never use background agents (`run_in_background: true`). Always use foreground subagents.
- IMPORTANT: **Respect other agents’ work and uncommitted state.** Another session may have deleted, moved, or partially replaced directories on purpose (e.g. CLI migration, package splits). Do **not** undo that by running `git restore`, `git checkout --`, or re-adding paths from `HEAD` to “fix the build” unless the **user explicitly** asked you to restore or reset. If the tree is dirty or half-migrated: report what you see, run checks only on packages you touched, or ask the user which direction to finish—**do not clobber parallel work** to get a green monorepo build.
- IMPORTANT: Use **Context7 MCP** (`resolve-library-id` → `query-docs`) for any external library/docs research. Always use it without asking — just call it directly when you need documentation or code examples for any dependency.
- Run `bun run fix` before every commit
- Use `bun run dt -- create` / `bun run dt -- start --file docker/compose.yaml` for CLI testing; see [`docker/README.md`](docker/README.md). `create` only writes under the current working directory; `start` rejects compose files outside CWD unless `--allow-outside` is passed.
- Never edit Drizzle generated SQL/files manually; only change schema files and regenerate
- Never edit `apps/obsr/src/db/auth-schema.ts` manually; regenerate it with `cd apps/obsr && npx auth generate --output ./src/db/auth-schema.ts --adapter drizzle --dialect postgresql --yes`
- Do not use `npx auth migrate` in `apps/obsr`; auth tables also flow through Drizzle migrations here
- Always generate Drizzle migrations via command (`cd apps/obsr && bun run db:generate` for active work)
- Never create markdown summary files when closing tasks
- There is **no legacy code path** in this repo; do not reintroduce `legacy/` or old extraction packages.

### Ask First

- Database schema changes affecting production
- Auth flow or token handling changes
- Webhook handler modifications

## Style

Biome/Ultracite handles standard linting. Project-specific only:

- **Files**: kebab-case (`user-profile.tsx`)
- **Types**: Interfaces over type aliases; import with `type` keyword
- **Functions**: Arrow functions only
- **Comments**: None unless critical; prefix hacks with `// HACK: reason`
- **Tailwind**: Read `globals.css` / design tokens first. Use semantic project-defined utility classes — no hardcoded values.

## Git

- Conventional commits, brief descriptions
- **Default workflow**: commit directly to `main` in this repo. Do not create a branch or open a PR unless the user explicitly asks for one.

## Plan Mode

- Extremely concise plans. Sacrifice grammar for brevity.
- End with unresolved questions if any.

## Local Dev (portless)

- **Docs**: `http://detent.localhost:1355`
- **Observer**: `http://obsr.localhost:1355`

## Production

- **Docs**: `detent.sh`
