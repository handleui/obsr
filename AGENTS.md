# Observer

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
- **Active App**: Next.js 16, React 19, Tailwind CSS (`apps/obsr`)
- **Docs**: Next.js 16 docs site (`apps/docs`)
- **Database**: Neon Postgres (Drizzle)
- **CLI**: TypeScript, Citty, Ink
- **AI**: Claude Haiku (fast) + GPT-5.2-Codex (smart) via Vercel AI Gateway — routing logic in `packages/ai`
- **Linting**: Biome via Ultracite
- **Icons**: `iconoir-react` — browse at [iconoir.com](https://iconoir.com). Do NOT grep `node_modules`.

## Project Structure

```
apps/
├── cli/            # Command-line interface
├── docs/           # Documentation app (Next.js)
└── obsr/           # Observer MVP app (Next.js)

legacy/
├── api/            # Legacy Cloudflare Workers API (reference only)
└── resolver/       # Legacy resolver service (reference only)

packages/
├── ai/             # AI model routing & providers
├── autofix/        # Deterministic autofix logic
├── extract/        # CI log parsing & error extraction
├── git/            # Git operations
├── resolving/      # AI error fixing orchestration
├── lore/           # Knowledge base
├── sandbox/        # E2B sandbox management
├── sentry/         # Sentry integration
├── types/          # Shared TypeScript types
├── ui/             # Shared React components
└── typescript-config/
```

## Database

Active Observer data lives in `apps/obsr`.

- **Observer MVP**: schema in `apps/obsr/src/db/schema.ts` → `cd apps/obsr && bun run db:generate`
- **Legacy API DB**: `packages/db` is reference-only unless you are intentionally touching legacy code

## Rules

- IMPORTANT: Never use background agents (`run_in_background: true`). Always use foreground subagents.
- IMPORTANT: Use **Context7 MCP** (`resolve-library-id` → `query-docs`) for any external library/docs research. Always use it without asking — just call it directly when you need documentation or code examples for any dependency.
- Run `bun run fix` before every commit
- Use `bun run dt x` for local CLI testing
- Never edit Drizzle generated SQL/files manually; only change schema files and regenerate
- Always generate Drizzle migrations via command (`cd apps/obsr && bun run db:generate` for active work)
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

- **Docs**: `http://detent.localhost:1355`
- **Observer**: `http://obsr.localhost:1355`
- **Legacy API**: `http://observer.localhost:1355`
- **Legacy Resolver**: `http://resolver.localhost:1355`

## Production

- **Docs**: `detent.sh`
- **Legacy API**: `observer.detent.sh`

## Resolving Architecture

- **Autofix** (deterministic): GitHub Action, no sandbox
- **Legacy AI Resolving** (agentic): kept in `legacy/resolver` for reference only
