# Detent

Self-healing CI/CD platform. Runs CI locally, uses AI to fix errors before pushing.

## Commands

```bash
# Build & Test
bun run build              # Build all (Turborepo)
bun run lint               # Check issues
bun run fix                # Auto-fix with Biome
bun run check-types        # TypeScript validation

# CLI (local dev)
bun run dt <command>       # Use local build (not ./dist/dt)

# CLI (production)
dt <command>               # Global install
detent <command>           # Alias

# Database (from apps/api/)
bun run db:generate        # Create migration after editing schema.ts
bun run db:migrate         # Apply migrations
bun run db:studio          # Open Drizzle Studio
```

## Tech Stack

- **Runtime**: Bun, Node.js 22
- **Monorepo**: Turborepo
- **API**: Hono on Cloudflare Workers
- **Database**: Neon PostgreSQL, Drizzle ORM (`drizzle-orm/pg-core`), Cloudflare Hyperdrive
- **Web**: Next.js 16, React 19, Tailwind CSS
- **CLI**: TypeScript, Citty, Ink
- **Auth**: WorkOS, JWT (Jose)
- **AI**: Codex 5.2 via Vercel AI Gateway
- **Sandboxes**: E2B (fresh per heal)
- **Linting**: Biome via Ultracite (handles all style rules automatically)

## Project Structure

```
apps/
├── api/       # Cloudflare Workers API (Hono)
├── healer/    # AI healing service (Railway)
├── cli/       # Command-line interface
├── navigator/ # Auth portal (Next.js)
├── web/       # Landing page (Next.js)
└── docs/      # Documentation

packages/
├── parser/    # CI log parsing
├── healing/   # AI error fixing
├── git/       # Git operations
└── ui/        # Shared React components
```

## Database Migrations

Source of truth: `apps/api/src/db/schema.ts`

1. Edit `schema.ts`
2. Run `db:generate` → creates migration in `drizzle/`
3. Run `db:migrate` → applies to database
4. Commit both `schema.ts` AND `drizzle/` files

## Boundaries

### Always Do
- Use Context7 MCP for library docs without being asked
- Run `bun run fix` before committing
- Use `bun run dt` for local CLI testing
- Edit `schema.ts` then run `db:generate` for DB changes

### Ask First
- Database schema changes affecting production
- Changes to auth flow or token handling
- Modifications to webhook handlers

### Never Do
- Edit files in `drizzle/*.sql` or `drizzle/meta/` directly (use `db:generate`)
- Use `db:push` in production (causes data loss on renames)
- Run `./dist/dt` directly (use `bun run dt` instead)
- Commit without running `bun run fix`

## Style (Project-Specific Only)

Biome handles all standard linting. These are project-specific deviations:

- **Files**: kebab-case (`user-profile.tsx`)
- **Types**: Interfaces over type aliases; import with `type` keyword
- **Functions**: Arrow functions only
- **Comments**: None unless critical; prefix hacks with `// HACK: reason`

## Git

- Conventional commits, header only, no description

## Plan Mode

- Extremely concise plans. Sacrifice grammar for brevity.
- End with unresolved questions if any.

## Production

- **URL**: `detent.sh`
- **API**: `backend.detent.sh`
- **Auth**: `navigator.detent.sh`

## Healing Architecture

- **Autofix (deterministic)**: Runs in GitHub Action, no sandbox
- **AI Healing (agentic)**: Separate Healer service on Railway
- **Sandbox**: Fresh E2B sandbox per heal (not persistent)
- **Flow**: API stores heal → Healer runs in E2B → patches to API → user reviews
