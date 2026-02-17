# Detent

Self-healing CI/CD platform. Runs CI locally, uses AI to fix errors before pushing.

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
- **DB Access**: Hyperdrive (Workers), direct Neon URL (Healer/Navigator), Convex service token
- **Web**: Next.js 16, React 19, Tailwind CSS
- **CLI**: TypeScript, Citty, Ink
- **Auth**: WorkOS, JWT (Jose)
- **AI**: Claude Haiku (fast) + GPT-5.2-Codex (smart) via Vercel AI Gateway — routing logic in `packages/ai`
- **Sandboxes**: E2B (fresh per heal)
- **Linting**: Biome via Ultracite
- **Icons**: `iconoir-react` — browse at [iconoir.com](https://iconoir.com). Do NOT grep `node_modules`.

## Project Structure

```
apps/
├── api/            # Cloudflare Workers API (Hono)
├── healer/         # AI healing service (Railway)
├── cli/            # Command-line interface
├── navigator/      # Dashboard + auth (Next.js)
└── web/            # Landing page (Next.js)

packages/
├── ai/             # AI model routing & providers
├── autofix/        # Deterministic autofix logic
├── code-storage/   # Heal file persistence
├── db/             # Drizzle schema, client, migrations
├── extract/        # CI log parsing & error extraction
├── git/            # Git operations
├── healing/        # AI error fixing orchestration
├── lore/           # Knowledge base
├── mcp/            # MCP server
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
- IMPORTANT: Use Nia MCP tools for any external code/docs research. Prefer `tracer`, `nia_package_search_hybrid`, and `nia_research` (no indexing needed) before falling back to `nia index`. Check `manage_resource(action='list')` before indexing.
- IMPORTANT: Nia is NOT for everything. Do NOT over-index. When indexing docs, index the root page, docs subdomain (e.g. `docs.example.com`), or `/docs` page — NOT specific subpages like `/pricing` or `/features`. The root/docs pages are what's actually valuable. Be selective.
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

## Production

- **App**: `detent.sh`
- **API**: `backend.detent.sh`
- **Dashboard**: `navigator.detent.sh`

## Navigator Proxy

- `apps/navigator/src/proxy.ts` is the Next.js middleware (Turbopack auto-detects it)
- Rewrites `/:org/:project/:run` → `/run/:org/:project/:run` for dashboard routes
- Real routes use provider prefixes: `gh/` (GitHub) or `gl/` (GitLab) — e.g. `/gh/detentsh/detent/159`
- Demo page uses `/handleui/detent/159` (no provider prefix) — rendered by `/run` page via proxy rewrite

## Healing Architecture

- **Autofix** (deterministic): GitHub Action, no sandbox
- **AI Healing** (agentic): Healer on Railway → E2B sandbox → patches to API → user reviews
