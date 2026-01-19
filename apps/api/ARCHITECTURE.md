# API Architecture

Cloudflare Workers API for the Detent self-healing CI/CD platform.

## Technology Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Neon PostgreSQL via Cloudflare Hyperdrive
- **ORM**: Drizzle
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
                     Webhooks           GitHub API       Actions
                            |                |                |
                            v                v                v
+------------------+   +--------+   +-----------------+   +--------+
|  GitHub Actions  |-->| /report|   |  Installation   |   | Healer |
|  (detent-action) |   +--------+   |     Tokens      |   | (Rail) |
+------------------+        |       +-----------------+   +--------+
                            |                                  |
                            v                                  v
                    +-------+--------+                  +------+------+
                    |                |                  |             |
                    |   Cloudflare   |<---------------->|   Neon DB   |
                    |    Workers     |                  |  (Postgres) |
                    |     (API)      |                  |             |
                    +-------+--------+                  +-------------+
                            |
            +---------------+---------------+
            |               |               |
        +---+---+     +-----+-----+   +-----+-----+
        |  CLI  |     | Navigator |   |    Web    |
        +-------+     +-----------+   +-----------+
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
- `POST /report` - Error reports from GitHub Actions
- `POST /v1/heal/autofix-result` - Autofix results from actions

### Protected Routes (JWT + Rate Limiting)
All routes under `/v1/`:
- `/auth` - User sync, GitHub orgs, token refresh
- `/organizations` - Organization management
- `/projects` - Project listing
- `/heal` - Heal operations (list, apply, reject)
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
   WorkOS Token            X-Detent-Token           X-Hub-Signature-256
   Bearer Auth             SHA-256 hash                   HMAC
         |                         |                         |
   userId, orgId             organizationId              Raw payload
         |                         |                         |
   Rate Limited               Rate Limited            No rate limit
```

### Organization Access Control

```
GitHub OAuth --> WorkOS --> JWT --> githubOrgAccessMiddleware
                                            |
                                   +--------+--------+
                                   |                 |
                            Personal Acct      GitHub Org
                            (owner only)      (membership check)
                                                     |
                                            +--------+--------+
                                            |                 |
                                      Existing DB        New Member
                                       Member           (verify via API)
                                            |                 |
                                      Use cached         Create record
                                        role             (seed role)
```

Role hierarchy: `owner > admin > member > visitor`

## Database Schema

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
            |       +-- heals (autofix/AI operations)
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
2. **JSONB settings**: Flexible org settings without migrations
3. **Run tracking**: Store ALL workflow runs (not just failures)
4. **Error signatures**: Fingerprinting for deduplication and analytics

## Webhook Handling

### GitHub Event Flow

```
+----------------------+     +---------------------+     +------------------+
| workflow_run         |     | check_suite         |     | installation     |
| (in_progress)        |     | (requested)         |     | (created/deleted)|
+----------+-----------+     +---------+-----------+     +--------+---------+
           |                           |                          |
   Create check run            Create check run            Upsert org/repos
   Post waiting comment        (backup path)
           |                           |
           v                           v
+----------+-----------+
| workflow_run         |
| (completed)          |
+----------+-----------+
           |
   +-------+-------+
   |               |
Wait for all    Lock commit
workflows       (idempotency)
   |               |
   +-------+-------+
           |
   Query job-reported errors
   (from /report endpoint)
           |
   +-------+-------+
   |               |
Finalize      Orchestrate
check run       autofixes
   |               |
Post PR        Create heal
comment         records
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
- `heal:project:pr:source` - Prevents duplicate heal creation

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
       +-- Check for existing pending heals
       +-- Acquire KV lock per source
       +-- Create heal records
       +-- Return configs for action execution
```

### services/webhooks/

Shared webhook utilities:
- Error parsing and classification
- DB operations (run existence checks, org settings)
- Comment formatting
- Job fetching with rate limit awareness

## Integration Points

### GitHub Actions (detent-action)

```
Action runs in CI --> Parses errors --> POST /report --> DB stores errors
                                              |
                                              v
                                     Webhook completes
                                              |
                                              v
                                     orchestrateHeals()
                                              |
                                              v
                                     Returns autofix configs
                                              |
                                              v
                                     Action executes fixes
                                              |
                                              v
                                     POST /v1/heal/autofix-result
                                              |
                                              v
                                     Update heal status
                                     (optional: auto-commit)
```

### Healer Service (Railway)

External service for AI healing:
- API stores heal record with pending status
- Healer polls or receives webhook trigger
- Healer executes AI agent in E2B sandbox
- Healer posts results back to API
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

### cleanup-stale-heals
- Runs periodically
- Marks stuck heals (pending >30m) as failed
- Handles Modal/Railway executor failures

## Error Handling

### Database Errors

```
DatabaseError class
       |
       +-- isTransient: true --> 503 + Retry-After
       |
       +-- isPermanent: true --> 400
       |
       +-- unknown --> 500
```

Pattern matching for classification:
- Connection errors -> transient
- Constraint violations -> permanent
- Timeout -> transient

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
3. **Hyperdrive**: Connection pooling for Postgres
4. **Background tasks**: `waitUntil` for non-critical operations
5. **Batch processing**: Sync job processes orgs in batches with delays

## Security Measures

1. **Credential scrubbing**: Sentry events sanitized before send
2. **Timing-safe comparison**: Webhook signatures, API keys
3. **Path traversal prevention**: File path validation in autofix results
4. **Rate limiting**: Upstash Redis for protected routes
5. **CORS**: Configurable allowed origins
6. **Generic error messages**: Prevent info leakage in auth failures
