# Detent

Self-resolving CI/CD platform. Runs CI locally, uses AI to fix errors before pushing.

## Commands

```bash
bun run build              # Build all (Turborepo)
bun run lint               # Check issues
bun run fix                # Auto-fix with Biome
bun run check-types        # TypeScript validation
bun run dt <command>       # CLI local dev (never use ./dist/dt)
```

## Tech Stack

- **Runtime**: Bun, Node >=18
- **Monorepo**: Turborepo
- **API**: Hono on Cloudflare Workers
- **Database**: Neon Postgres (Drizzle) + Convex (realtime)
- **DB Access**: Hyperdrive (Workers), direct Neon URL (Resolver/Navigator), Convex service token
- **Web**: Next.js 16, React 19, Tailwind CSS
- **CLI**: TypeScript, Citty, Ink
- **Auth**: WorkOS, JWT (Jose)
- **AI**: Claude Haiku (fast) + GPT-5.2-Codex (smart) via Vercel AI Gateway — routing logic in `packages/ai`
- **Sandboxes**: E2B (fresh per resolve)
- **Linting**: Biome via Ultracite
- **Icons**: `iconoir-react` — browse at [iconoir.com](https://iconoir.com). Do NOT grep `node_modules`.

## Project Structure

```
apps/
├── observer/       # Cloudflare Workers Observer service (Hono)
├── resolver/       # AI resolving service (Railway)
├── cli/            # Command-line interface
├── navigator/      # Auth portal + dashboard (Next.js; deprecated, deferred until CLI limits are in place)
└── web/            # Landing page (Next.js)

packages/
├── ai/             # AI model routing & providers
├── autofix/        # Deterministic autofix logic
├── db/             # Drizzle schema, client, migrations
├── extract/        # CI log parsing & error extraction
├── git/            # Git operations
├── resolving/        # AI error fixing orchestration
├── lore/           # Knowledge base
├── sandbox/        # E2B sandbox management
├── sdk/            # Public SDK
├── sentry/         # Sentry integration
├── types/          # Shared TypeScript types
├── ui/             # Shared React components
└── typescript-config/
```

## Database

Dual-DB: Neon Postgres (non-realtime) + Convex (realtime).

- **Neon**: Schema in `packages/db/src/schema/` → `drizzle-kit generate` → `drizzle-kit migrate`
- **Convex**: Schema at `convex/schema.ts` → edit mutations/queries → `npx convex deploy`

## Rules

- IMPORTANT: Never use background agents (`run_in_background: true`). Always use foreground subagents.
- IMPORTANT: Use **Context7 MCP** (`resolve-library-id` → `query-docs`) for any external library/docs research. Always use it without asking — just call it directly when you need documentation or code examples for any dependency.
- Run `bun run fix` before every commit
- Use `bun run dt x` for local CLI testing
- Never edit Convex `_generated/` files
- Never edit Drizzle generated SQL/files manually (including `packages/db/drizzle/**`); only change schema files and regenerate
- Never create markdown summary files when closing tasks

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

## Plan Mode

- Extremely concise plans. Sacrifice grammar for brevity.
- End with unresolved questions if any.

## Local Dev (portless)

- **Navigator**: `http://navigator.localhost:1355` (deprecated; deferred until CLI limits are in place)
- **Web**: `http://detent.localhost:1355`
- **API**: `http://observer.localhost:1355`
- **Resolver**: `http://resolver.localhost:1355`

## Production

- **App**: `detent.sh`
- **API**: `observer.detent.sh`
- **Dashboard**: `navigator.detent.sh`

## Resolving Architecture

- **Autofix** (deterministic): GitHub Action, no sandbox
- **AI Resolving** (agentic): Resolver on Railway → E2B sandbox → patches to API → user reviews
