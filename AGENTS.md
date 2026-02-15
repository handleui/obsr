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
```

## Tech Stack

- **Runtime**: Bun, Node.js 22
- **Monorepo**: Turborepo
- **API**: Hono on Cloudflare Workers
- **Database**: Convex (serverless backend), schema at `convex/schema.ts`
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

## Database

Source of truth: `convex/schema.ts`

1. Edit `convex/schema.ts`
2. Edit corresponding mutation/query files in `convex/`
3. Deploy via `npx convex deploy` (schema changes apply automatically)
4. Commit schema and mutation files together

## Boundaries

# Never use background agents (run_in_background: true). Always use foreground subagents that block/yield until completion.

### Always Do
- When answering questions involving external documentation, APIs, or specifications, prefer using Nia MCP tools to retrieve and verify information before responding. Use reasoning first to determine whether external grounding is necessary.
- **Do NOT spam `nia index`**. Search what's already indexed first (`manage_resource(action='list')`). If not available, use **Context7** (`mcp__context7`) instead of indexing. Only index when the source will be reused repeatedly, and always index top-level URLs (e.g., `handleui.com/docs`, not deep subpages).
- Run `bun run fix` before committing
- Use `bun run dt x` for local CLI testing
- Edit `convex/schema.ts` then deploy for DB changes

### Ask First
- Database schema changes affecting production
- Changes to auth flow or token handling
- Modifications to webhook handlers

### Never Do
- Edit Convex `_generated/` files directly
- Run `./dist/dt` directly (use `bun run dt` instead)
- Commit without running `bun run fix`
- Create markdown files when closing tasks (no summaries or reports needed)

## Icons

- **Library**: `iconoir-react` — browse available icons at [iconoir.com](https://iconoir.com) or use Nia/Context7 to search. Do NOT grep `node_modules/dist` to find icons.

## Style (Project-Specific Only)

Biome handles all standard linting. These are project-specific deviations:

- **Files**: kebab-case (`user-profile.tsx`)
- **Types**: Interfaces over type aliases; import with `type` keyword
- **Functions**: Arrow functions only
- **Comments**: None unless critical; prefix hacks with `// HACK: reason`
- **Tailwind**: Always read `globals.css` / design tokens first. Use semantic and project-defined utility classes — no hardcoded values or redundant classes.

## Git

- Conventional commits, semver, make descriptions brief

## Plan Mode

- Extremely concise plans. Sacrifice grammar for brevity.
- End with unresolved questions if any.

## Production

- **URL**: `detent.sh`
- **API**: `backend.detent.sh`
- **Auth**: `navigator.detent.sh`

## Navigator Proxy (Middleware)

- `apps/navigator/src/proxy.ts` is the Next.js middleware (Turbopack auto-detects it)
- Rewrites `/:org/:project/:run` → `/run/:org/:project/:run` for dashboard routes
- Real app routes use provider prefixes: `gh/` (GitHub) or `gl/` (GitLab) — e.g. `/gh/detentsh/detent/159`
- Demo page uses `/handleui/detent/159` (no provider prefix) — this is NOT a real app route, just demo data rendered by the same `/run` page via the proxy rewrite

## Healing Architecture

- **Autofix (deterministic)**: Runs in GitHub Action, no sandbox
- **AI Healing (agentic)**: Separate Healer service on Railway
- **Sandbox**: Fresh E2B sandbox per heal (not persistent)
- **Flow**: API stores heal → Healer runs in E2B → patches to API → user reviews
