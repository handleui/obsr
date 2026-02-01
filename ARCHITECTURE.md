# Detent Architecture

## Overview

A self-healing CI/CD platform that runs CI locally and uses AI (Claude) to automatically fix errors before pushing to remote. Bridges local development and CI pipelines with intelligent error correction.

**Core Value:** Fast feedback loop + AI-powered healing + Git-aware checking

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              DETENT PLATFORM                                     │
└─────────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
                    │         CI PROVIDERS (External)       │
                    │  ┌─────────────┐  ┌─────────────────┐ │
                    │  │   GitHub    │  │     GitLab      │ │
                    │  │   Actions   │  │       CI        │ │
                    │  └──────┬──────┘  └────────┬────────┘ │
                    └─────────┼──────────────────┼──────────┘
                              │ webhooks         │
                              │ workflow_run     │ pipeline
                              ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            CLOUDFLARE WORKERS                                    │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                           API (apps/api)                                  │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │   Webhooks   │  │    Auth      │  │   Autofix    │  │   Billing    │  │   │
│  │  │   Handler    │  │   Routes     │  │   Service    │  │   Service    │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                       │                                          │
│              ┌────────────────────────┼────────────────────────┐                │
│              ▼                        ▼                        ▼                │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐          │
│  │  Cloudflare KV   │    │     Convex       │    │  Upstash Redis   │          │
│  │  (idempotency)   │    │ (DB + functions) │    │  (rate limit)    │          │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                              WEB APPS (Vercel)                                   │
│                                                                                  │
│  ┌──────────────────────────┐          ┌──────────────────────────┐             │
│  │   Navigator (Next.js)    │          │     Web (Next.js)        │             │
│  │  ┌────────────────────┐  │          │  ┌────────────────────┐  │             │
│  │  │ /auth/login        │  │          │  │ Landing Page       │  │             │
│  │  │ /auth/callback     │◄─┼──WorkOS──│  │ Public Site        │  │             │
│  │  │ /invitations/[id]  │  │  OAuth   │  │ Documentation      │  │             │
│  │  └────────────────────┘  │          │  └────────────────────┘  │             │
│  └──────────────────────────┘          └──────────────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           HEALER SERVICE (Railway)                               │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                         Healer (apps/healer)                              │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                    │   │
│  │  │   Poller     │  │  E2B Client  │  │   Healing    │                    │   │
│  │  │   Service    │  │  (Sandbox)   │  │   Package    │                    │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                    │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────┐
│                           USER'S MACHINE (Local)                                 │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │                          CLI (apps/cli)                                   │   │
│  │                                                                           │   │
│  │   ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐            │   │
│  │   │ dt auth   │  │ dt link   │  │ dt config │  │ dt errors │            │   │
│  │   └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘            │   │
│  │         │              │              │              │                   │   │
│  │         ▼              ▼              ▼              ▼                   │   │
│  │   ┌─────────────────────────────────────────────────────────────────┐   │   │
│  │   │                    Core Libraries                                │   │   │
│  │   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │   │   │
│  │   │  │ @detent/git │  │ @detent/lore│ │   @detent/healing       │  │   │   │
│  │   │  │ clone/push  │  │ hints/sigs  │ │   ┌─────────────────┐   │  │   │   │
│  │   │  │ branches    │  ├─────────────┤ │   │  Codex 5.2      │   │  │   │   │
│  │   │  │ diff/commit │  │@detent/types│ │   │  (AI Gateway)   │   │  │   │   │
│  │   │  └─────────────┘  │ shared types│ │   │  ┌───────────┐  │   │  │   │   │
│  │   │                   └─────────────┘ │   │  │   Tools   │  │   │  │   │   │
│  │   │                                   │   │  │ read_file │  │   │  │   │   │
│  │   │                                   │   │  │ edit_file │  │   │  │   │   │
│  │   │                                   │   │  │ glob/grep │  │   │  │   │   │
│  │   │                                   │   │  │ execute   │  │   │  │   │   │
│  │   │                                   │   │  └───────────┘  │   │  │   │   │
│  │   │                                   │   └─────────────────┘   │  │   │   │
│  │   │                                   └─────────────────────────┘  │   │   │
│  │   └─────────────────────────────────────────────────────────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│  ~/.detent/                                                                      │
│  ├── credentials.json    # JWT + GitHub OAuth tokens                            │
│  └── config.jsonc        # User preferences (heal budget, trust, org)           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Healing Loop

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CI ERROR HEALING FLOW                                │
└─────────────────────────────────────────────────────────────────────────────┘

  Developer pushes
        │
        ▼
┌───────────────┐      webhook        ┌──────────────┐
│ GitHub Actions│ ──────────────────► │  Detent API  │
│ workflow fails│                     │              │
└───────────────┘                     └──────┬───────┘
                                             │
                                             ▼
                                    ┌──────────────────┐
                                    │  Log Extractor   │
                                    │  (fetch CI logs) │
                                    └────────┬─────────┘
                                             │
                                             ▼
                                    ┌──────────────────┐
                                    │  @detent/action  │
                                    │  (GitHub Action) │
                                    │  parse errors    │
                                    └────────┬─────────┘
                                             │
                                             ▼
                                    ┌──────────────────┐
                                    │   Store Errors   │
                                    │   (RunErrors)    │
                                    └────────┬─────────┘
                                             │
                            ┌────────────────┼────────────────┐
                            ▼                ▼                ▼
                    ┌───────────────┐ ┌────────────┐ ┌───────────────┐
                    │  PR Comment   │ │  Autofix   │ │  AI Healing   │
                    │  (summary)    │ │(deterministic)│(if enabled)  │
                    └───────────────┘ └────────────┘ └───────┬───────┘
                                                              │
                                                              ▼
                                         ┌────────────────────────────────────┐
                                         │     Healer Service (Railway)       │
                                         │  ┌─────────────────────────────┐   │
                                         │  │ 1. Poll for pending heals   │   │
                                         │  │ 2. Spin up E2B sandbox      │   │
                                         │  │ 3. Run Codex 5.2 via AI SDK │   │
                                         │  │ 4. Apply fixes in sandbox   │   │
                                         │  │ 5. Verify and iterate       │   │
                                         │  │ 6. POST patches to API      │   │
                                         │  └─────────────────────────────┘   │
                                         └────────────────┬───────────────────┘
                                                          │
                                                          ▼
                                                  ┌───────────────┐
                                                  │  User Reviews │
                                                  │  Patches      │
                                                  └───────────────┘
```

---

## Directory Structure

```
detent/
├── apps/
│   ├── api/                          # Backend API (Cloudflare Workers)
│   │   ├── src/
│   │   │   ├── index.ts              # Hono app entry, middleware stack
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts           # /v1/auth/* - login, verify, sync identity
│   │   │   │   ├── organizations.ts  # /v1/organizations/* - CRUD orgs
│   │   │   │   ├── errors.ts         # /v1/errors - retrieve stored errors
│   │   │   │   ├── heal.ts           # /v1/heal - request AI healing
│   │   │   │   ├── webhooks.ts       # /webhooks/* - GitHub/GitLab handlers
│   │   │   │   └── health.ts         # /health - status check
│   │   │   ├── services/
│   │   │   │   ├── github/           # GitHub App API, checks, installs
│   │   │   │   ├── autofix/          # Deterministic autofix orchestration
│   │   │   │   ├── healer.ts         # Request AI healing (stores in DB)
│   │   │   │   ├── billing.ts        # Subscription/usage billing
│   │   │   │   ├── log-extractor.ts  # Fetch CI logs from providers
│   │   │   │   └── idempotency.ts    # Webhook deduplication (KV + DB)
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           # JWT verification
│   │   │   │   └── rate-limit.ts     # Upstash Redis rate limiting
│   │   │   └── db/
│   │   │       ├── convex.ts         # Convex client helpers
│   │   │       └── index.ts          # DB exports
│   │   └── wrangler.jsonc            # Cloudflare Workers config
│   │
│   ├── cli/                          # Command-line interface
│   │   ├── src/
│   │   │   ├── index.ts              # Entry point, auto-update, Sentry
│   │   │   ├── commands/
│   │   │   │   ├── auth/             # dt auth - device flow login
│   │   │   │   ├── link/             # dt link - connect repo to org
│   │   │   │   ├── config/           # dt config - manage preferences
│   │   │   │   ├── org/              # dt org - organization mgmt
│   │   │   │   ├── errors.ts         # dt errors - view CI errors
│   │   │   │   └── whoami.ts         # dt whoami - current user
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts           # WorkOS Device Authorization
│   │   │   │   ├── api.ts            # Authenticated API client
│   │   │   │   ├── credentials.ts    # Token storage (~/.detent/)
│   │   │   │   └── config.ts         # Config file handling (JSONC)
│   │   │   └── tui/                  # Terminal UI components (Ink)
│   │   └── build.ts                  # bun build → standalone binary
│   │
│   ├── navigator/                    # Auth portal (Next.js 16)
│   │   └── src/
│   │       └── app/
│   │           ├── auth/login/       # Initiate WorkOS OAuth
│   │           ├── auth/callback/    # Handle OAuth callback
│   │           ├── invitations/      # Accept email invites
│   │           └── api/auth/         # Session management APIs
│   │
│   ├── web/                          # Public landing (Next.js)
│   │   └── src/app/
│   │       └── page.tsx              # Landing page
│   │
│   ├── healer/                       # AI Healing Service (Railway)
│   │   └── src/
│   │       ├── index.ts              # Hono app, graceful shutdown
│   │       ├── services/
│   │       │   └── poller/           # Poll Convex for pending heals
│   │       ├── adapters/             # E2B sandbox adapter
│   │       └── routes/               # Health check routes
│   │
│   └── docs/                         # Documentation site
│
├── convex/                           # Convex schema + functions
│
├── packages/
│   ├── action/                       # GitHub Action for parsing
│   │   └── src/                      # Runs client-side in CI
│   │
│   ├── lore/                         # Error hints and signatures
│   │   └── src/
│   │       ├── hints/                # Context-aware error hints
│   │       └── signatures/           # Error pattern signatures
│   │
│   ├── types/                        # Shared TypeScript types
│   │   └── src/                      # Common interfaces and enums
│   │
│   ├── healing/                      # AI-powered error fixing
│   │   └── src/
│   │       ├── client.ts             # Codex 5.2 via Vercel AI Gateway
│   │       ├── loop.ts               # Multi-turn conversation loop
│   │       ├── tools/                # AI tool implementations
│   │       │   ├── read-file.ts      # Read source files
│   │       │   ├── edit-file.ts      # Apply code edits
│   │       │   ├── glob.ts           # Find files by pattern
│   │       │   ├── grep.ts           # Search file contents
│   │       │   ├── execute.ts        # Run shell commands
│   │       │   └── run-check.ts      # Run linting/tests
│   │       └── prompt/               # System prompts
│   │
│   ├── git/                          # Git operations
│   │   └── src/
│   │       ├── clone.ts              # Clone to temp directory
│   │       ├── branch.ts             # Branch management
│   │       ├── diff.ts               # Changed file detection
│   │       └── lock.ts               # Concurrent operation safety
│   │
│   ├── ui/                           # Shared React components
│   │   └── src/
│   │       ├── button.tsx            # CVA-styled button
│   │       └── input.tsx             # Form input component
│   │
│   └── typescript-config/            # Shared tsconfig presets
│
├── turbo.json                        # Turborepo pipeline config
├── biome.json                        # Biome (lint/format) config
└── package.json                      # Root workspace config
```

---

## Data Model (Convex)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CONVEX COLLECTIONS                                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   enterprises    │     │  organizations   │     │     projects     │
├──────────────────┤     ├──────────────────┤     ├──────────────────┤
│ id               │◄────│ enterpriseId?    │◄────│ organizationId   │
│ name             │     │ id               │     │ id               │
│ slug             │     │ name, slug       │     │ handle           │
│ suspendedAt?     │     │ provider         │     │ providerRepoId   │
│ deletedAt?       │     │ providerAcctId   │     │ providerRepoName │
└──────────────────┘     │ providerAcctLogin│     │ isPrivate        │
                         │ installationId   │     │ removedAt?       │
                         │ settings         │     └────────┬─────────┘
                         └────────┬─────────┘              │
                                  │                        │
                                  ▼                        ▼
                    ┌──────────────────────┐    ┌──────────────────┐
                    │ organizationMembers  │    │       runs       │
                    ├──────────────────────┤    ├──────────────────┤
                    │ id                   │    │ id               │
                    │ organizationId       │    │ projectId        │
                    │ userId (WorkOS)      │    │ runId            │
                    │ role (owner/admin/   │    │ commitSha        │
                    │       member)        │    │ prNumber?        │
                    │ providerUserId       │    │ conclusion       │
                    │ providerUsername     │    │ workflowName     │
                    └──────────────────────┘    │ headBranch       │
                                                │ errorCount       │
                    ┌──────────────────────┐    └────────┬─────────┘
                    │    invitations       │             │
                    ├──────────────────────┤             ▼
                    │ id                   │    ┌──────────────────┐
                    │ organizationId       │    │    runErrors     │
                    │ email                │    ├──────────────────┤
                    │ role                 │    │ id               │
                    │ token (unique)       │    │ runId            │
                    │ status (pending/     │    │ filePath         │
                    │   accepted/expired)  │    │ line, column     │
                    │ expiresAt            │    │ message          │
                    └──────────────────────┘    │ category         │
                                                │ severity         │
                    ┌──────────────────────┐    │ codeSnippet      │
                    │     prComments       │    │ suggestions      │
                    ├──────────────────────┤    │ workflowJob      │
                    │ id                   │    │ workflowStep     │
                    │ repository           │    └──────────────────┘
                    │ prNumber             │
                    │ commentId (GitHub)   │
                    └──────────────────────┘
```

---

## Auth Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                    CLI AUTHENTICATION (Device Flow)                     │
└────────────────────────────────────────────────────────────────────────┘

   User Terminal                    WorkOS                 Navigator
        │                             │                        │
        │  dt auth                    │                        │
        │──────────────────────────►  │                        │
        │    requestDeviceAuth()      │                        │
        │                             │                        │
        │  ◄────────────────────────  │                        │
        │   device_code + user_code   │                        │
        │                             │                        │
        │  Display: "Visit detent.sh/auth and enter: XXXX"     │
        │                             │                        │
        │                             │    User opens browser  │
        │                             │ ─────────────────────► │
        │                             │                        │
        │                             │    OAuth redirect      │
        │                             │ ◄───────────────────── │
        │                             │                        │
        │  pollForTokens() ───────►   │                        │
        │  (every 5 sec)              │                        │
        │                             │                        │
        │  ◄────────────────────────  │                        │
        │   access_token + id_token   │                        │
        │                             │                        │
        │  Save to ~/.detent/credentials.json                  │
        │                             │                        │
        ▼                             │                        │
   Authenticated!                     │                        │
```

---

## Key Commands

```bash
# Development
bun run dev               # All apps in dev mode
bun run build             # Build everything (Turborepo)
bun run dt <cmd>          # Run CLI locally (uses local build)

# Code Quality
bun run lint              # Check with Ultracite/Biome
bun run fix               # Auto-fix issues
bun run check-types       # TypeScript type checking

# CLI Commands
dt auth                   # Authenticate with Detent
dt link                   # Link repo to organization
dt config                 # Manage preferences
dt whoami                 # Show current user
dt errors                 # View CI errors
dt org                    # Organization management
```

---

## Tech Stack Summary

| Layer       | Technology                             |
|-------------|---------------------------------------|
| CLI         | TypeScript, Citty, Ink (React)        |
| API         | Hono, Cloudflare Workers              |
| Healer      | Hono, Bun, Railway                    |
| Database    | Convex                               |
| Web Apps    | Next.js 16, React 19, Tailwind        |
| Auth        | WorkOS, JWT (Jose), OAuth 2.0         |
| AI          | Codex 5.2 via Vercel AI Gateway       |
| Sandboxes   | E2B (fresh per heal)                  |
| Monorepo    | Turborepo, Bun                        |
| Lint/Format | Ultracite (Biome)                     |
| Monitoring  | Sentry, Logtail                       |
