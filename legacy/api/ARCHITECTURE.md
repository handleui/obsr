# API Architecture

Cloudflare Workers API for the Observer diagnostics platform.
Resolver integration exists as an optional sibling capability and is not required for core diagnostics workflows.

## Technology Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Data Store**: Neon Postgres via `@obsr/db` operations
- **Caching**: Cloudflare KV (idempotency, rate limiting)
- **Observability**: Sentry

## High-Level Architecture

```
                                    +------------------+
                                    |   GitHub/GitLab  |
                                    +--------+---------+
                                             |
                            +----------------+----------------+
                            |                |                |
                     Webhooks           GitHub API        Resolver
                            |                |                |
                            v                v                v
                    +-----------+   +-----------------+   +--------+
                    | workflow  |   |  Installation   |   | Resolver |
                    |   _job    |   |     Tokens      |   | (Rail) |
                    +-----------+   +-----------------+   +--------+
                            |                                  |
                            v                                  v
                    +-------+--------+                  +-------------+
                    |                |                  |             |
                    |   Cloudflare   |<---------------->| Neon Postgres|
                    |    Workers     |                  | (DB + funcs)|
                    |     (API)      |                  |             |
                    +-------+--------+                  +-------------+
                            |
            +---------------+---------------+
            |               |               |
        +---+---+     +-----+-----+   +-----+-----+
        |  CLI  |     |   Web App   |
        +-------+     +-------------+
```

## Request Flow

```
Request --> CORS --> Security Headers --> Sentry Context --> Route Handlers
                                                                   |
                                           +-----------------------+
                                           |
               +---------------------------+---------------------------+
               |                           |                           |
         Public Routes              Webhook Routes              Protected Routes
         (/health)                  (/webhooks)                 (/v1/*)
                                         |                           |
                                 Signature Verify             JWT Auth + Rate Limit
                                         |                           |
                                   Event Handlers              Route Handlers
```

## Route Structure

### Public Routes
- `GET /` - API health check
- `GET /health` - Detailed health status

### Webhook Routes (Signature Verified)
- `POST /webhooks/github` - GitHub App webhooks
- `POST /webhooks/polar` - Polar billing webhooks

### API Key Routes (X-Detent-Token)
- `POST /v1/resolve/autofix-result` - Autofix results from actions

### Protected Routes (JWT + Rate Limiting)
All routes under `/v1/`:
- `/auth` - User sync, GitHub orgs, token refresh
- `/organizations` - Organization management
- `/projects` - Project listing
- `/resolve` - Resolve operations (list, apply, reject)
- `/billing` - Subscription management
- `/orgs/:orgId/*` - Org-scoped resources (API keys, secrets, invitations)

## Authentication & Authorization

### Three Auth Patterns

```
+-------------------+     +-------------------+     +-------------------+
|   JWT Auth        |     |   API Key Auth    |     |   Webhook Sig     |
|   (User APIs)     |     |   (Machine APIs)  |     |   (Provider)      |
+-------------------+     +-------------------+     +-------------------+
         |                         |                         |
   Better Auth Session/Bearer  X-Detent-Token           X-Hub-Signature-256
   Bearer Auth             SHA-256 hash                   HMAC
         |                         |                         |
   userId, orgId             organizationId              Raw payload
         |                         |                         |
   Rate Limited               Rate Limited            No rate limit
```

### Organization Access Control

```
GitHub OAuth --> Better Auth --> Session/Bearer --> githubOrgAccessMiddleware
                                            |
                                   +--------+--------+
                                   |                 |
                            Personal Acct      GitHub Org
                            (owner only)      (membership check)
                                                     |
                                            +--------+--------+
                                            |                 |
                                     Existing record     New Member
                                       Member           (verify via API)
                                            |                 |
                                      Use cached         Create record
                                        role             (seed role)
```

Role hierarchy: `owner > admin > member > visitor`

## Data Model (Neon)

### Core Entities

```
enterprises (stub)
    |
    +-- organizations (GitHub/GitLab accounts)
            |
            +-- organization_members (user memberships)
            |
            +-- invitations (pending email invites)
            |
            +-- projects (repositories)
            |       |
            |       +-- runs (workflow executions)
            |       |       |
            |       |       +-- run_errors (extracted errors)
            |       |
            |       +-- resolves (autofix/AI operations)
            |
            +-- api_keys (machine auth)
            |
            +-- usage_events (billing)

error_signatures (global, deduplicated fingerprints)
    |
    +-- error_occurrences (per-project tracking)

pr_comments (deduplication table)
```

### Key Design Decisions

1. **Soft deletes**: `removedAt` timestamp instead of hard delete
2. **Flexible settings**: Org settings stored as a structured object
3. **Run tracking**: Store ALL workflow runs (not just failures)
4. **Error signatures**: Fingerprinting for deduplication and analytics

## Webhook Handling

### GitHub Event Flow

```
+----------------------+     +---------------------+     +------------------+
| workflow_job         |     | check_suite         |     | installation     |
| (queued/in_progress) |     | (requested)         |     | (created/deleted)|
+----------+-----------+     +---------+-----------+     +--------+---------+
           |                           |                          |
   Track job status            Create check run            Upsert org/repos
                               (backup path)
           |
           v
+----------+-----------+
| workflow_job         |
| (completed)          |
+----------+-----------+
           |
   +-------+-------+
   |               |
On failure      Update job
   |            stats
   v               |
Fetch logs         |
   |               |
   v               |
AI extract         |
errors             |
   |               |
   v               |
Store errors       |
   |               |
   +-------+-------+
           |
   +-------+-------+
   |               |
Create resolves    Post PR
if errors       comment
```

### Idempotency Strategy

```
KV Lock Acquisition --> Process Webhook --> Release Lock
        |                                        ^
        |                                        |
        +-- Already locked? --> Return early ----+
```

Lock types:
- `commit:repo:sha` - Prevents duplicate workflow_run processing
- `pr_comment:repo:pr` - Prevents duplicate PR comments
- `resolve:project:pr:source` - Prevents duplicate resolve creation

## Service Layer

### services/github/

Core GitHub API operations:
- Token management (JWT, installation tokens)
- Check runs (create, update)
- Comments (post, update)
- Workflow/job queries
- Rate limit handling with backoff

Singleton pattern with in-memory token cache (per isolate).

### services/autofix/

```
orchestrateHeals()
       |
       +-- Filter fixable errors
       +-- Group by source (biome, eslint, etc.)
       +-- Check for existing pending resolves
       +-- Acquire KV lock per source
       +-- Create resolve records
       +-- Return configs for action execution
```

### services/webhooks/

Shared webhook utilities:
- DB operations (run existence checks, org settings)
- Comment formatting
- Job fetching with rate limit awareness

## Integration Points

### Webhook-First Error Extraction

```
workflow_job.completed (failure)
           |
           v
   Fetch workflow logs
   (GitHub API)
           |
           v
   AI extracts errors
   (@obsr/legacy-extract)
           |
           v
   Store errors in DB
           |
           v
   Create resolve records
   (if auto-trigger enabled)
```

Error extraction happens automatically when a workflow job fails. The `@obsr/legacy-extract` package is the legacy compatibility layer for the old CIError-based flow and is kept under `/legacy`.

Legacy CI/error contracts used by this flow now live in `legacy/types` as `@obsr/legacy-types`.

### Resolver Service (Railway)

External service for AI resolving:
- API stores resolve record with pending status
- Resolver receives queue webhook from QStash
- Resolver executes AI agent in E2B sandbox
- Resolver posts results back to API
- API stores patch, optionally auto-commits

### Polar Billing

```
User subscribes --> Polar webhook --> Update customer ID
                                              |
                              subscription.active/canceled
                                              |
                                     Update org state
                                              |
                                     Usage events tracked
```

## Scheduled Jobs

Cron triggers in `wrangler.toml`:

### sync-organizations
- Runs periodically
- Syncs repos (add new, soft-delete removed)
- Reconciles member status with GitHub
- Updates lastSyncedAt

### cleanup-stale-resolves
- Runs periodically
- Marks stuck resolves (pending >30m) as failed
- Handles Modal/Railway executor failures

## Error Handling

### Webhook Error Classification

Error codes returned to GitHub:
- `RATE_LIMITED` - GitHub API limits
- `PERMISSION_DENIED` - App lacks permissions
- `INSTALLATION_NOT_FOUND` - App uninstalled
- `INTERNAL_ERROR` - Unexpected failures

All errors captured to Sentry with context.

## Performance Optimizations

1. **Token caching**: Installation tokens cached in-memory per isolate
2. **KV caching**: Org members, API keys cached with TTL
3. **Background tasks**: `waitUntil` for non-critical operations
4. **Batch processing**: Sync job processes orgs in batches with delays

## Security Measures

1. **Credential scrubbing**: Sentry events sanitized before send
2. **Timing-safe comparison**: Webhook signatures, API keys
3. **Path traversal prevention**: File path validation in autofix results
4. **Rate limiting**: Upstash Redis for protected routes
5. **CORS**: Configurable allowed origins
6. **Generic error messages**: Prevent info leakage in auth failures
