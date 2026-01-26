# @detent/api

## 1.2.0

### Minor Changes

- 8c0d460: Add user instructions support for `@detentsh` command with prompt injection protection.
  Users can now provide context with `@detentsh <instructions>` to guide AI healing.
  Includes input sanitization, length limits, and pattern-based injection blocking.

### Patch Changes

- Updated dependencies [8c0d460]
  - @detent/healing@0.4.6

## 1.1.0

### Minor Changes

- 89239c2: Add `@detent heal` command and move check runs to heal trigger time.
  Check runs are no longer created automatically when CI starts. Instead, they are created when a user triggers healing via the `@detent heal` PR comment or dashboard. This reduces noise and gives users explicit control over when healing happens.
- a44c02e: Add provider-based organization routes for GitHub/GitLab lookups.
  New endpoints: `/orgs/:provider/:slug`, `/orgs/:provider/:slug/membership`,
  `/orgs/:provider/:slug/projects`, and `/orgs/:provider/:slug/projects/:handle`.

## 1.0.1

### Patch Changes

- dbbee2f: Add billing enforcement to heal creation requests to prevent unbilled heals.
- 00c1fe2: Remove VERCEL_OIDC_TOKEN environment variable support.
  Vercel sandbox authentication now requires VERCEL_TOKEN with VERCEL_TEAM_ID and VERCEL_PROJECT_ID.
- Updated dependencies [00c1fe2]
  - @detent/sandbox@0.1.1

## 1.0.0

### Major Changes

- e1cb50b: Replace log-based parsing with JSON-based error collection.

  Removes @detent/parser dependency entirely. Error parsing now happens at the source via the new GitHub Action, which sends structured JSON to the /report endpoint. This eliminates regex-based log parsing in favor of consuming native JSON output from CI tools (ESLint, Vitest, golangci-lint, Cargo, TypeScript).

  Adds API key authentication (X-Detent-Token) for machine-to-machine communication and GitHub secrets encryption for automated token provisioning.

### Minor Changes

- 3855800: Add heals layer for autofix orchestration with Modal executor integration.

  Introduces the `heals` table to track autofix and AI heal operations, organization settings for auto-commit behavior, KV-based deduplication locks, and a webhook endpoint for executor callbacks. Includes GitHub Data API integration for pushing commits directly to PR branches.

### Patch Changes

- bc8a964: Migrate from local PostgreSQL/Docker to Neon for development.
  Remove docker-compose.yml and local database setup scripts in favor of direct Neon connection via Hyperdrive.
- Updated dependencies [e1cb50b]
- Updated dependencies [e1cb50b]
  - @detent/healing@0.4.4
  - @detent/lore@0.2.1
  - @detent/types@0.5.0

## 0.21.0

### Minor Changes

- bfd92f5: - Optimize workflow run processing by storing passing runs without fetching logs
  - BREAKING: Failed workflow runs now report `failure` conclusion instead of `neutral`
  - Add "skipped" conclusion when no CI-relevant workflows are found
  - Add mintlify to workflow blacklist

## 0.20.0

### Minor Changes

- 74eab1c: Add error signature and occurrence tracking for cross-repo error analytics.
  New database tables `error_signatures` and `error_occurrences` store deduplicated error patterns.
  Errors are now fingerprinted on ingest and linked to signatures for historical tracking.

### Patch Changes

- Updated dependencies [74eab1c]
- Updated dependencies [74eab1c]
- Updated dependencies [74eab1c]
  - @detent/parser@0.7.0
  - @detent/types@0.4.0
  - @detent/lore@0.2.0
  - @detent/healing@0.4.3

## 0.19.0

### Minor Changes

- afb9b1d: Add React Email templates for organization invitations.
  Replaces inline HTML with reusable email components and shared layout.

### Patch Changes

- 1ae043d: Fix race condition where workflows weren't visible immediately after check_suite.requested.
  Adds 3-second delay before fetching workflows and posts waiting comment from workflow_run
  handler as fallback when check_suite fails to acquire the lock.

## 0.18.0

### Minor Changes

- 0812dd0: Add organization member management and background sync capabilities.

  New features:

  - GET/DELETE endpoints for managing org members with role-based access control
  - Scheduled cron job (every 6 hours) to sync all orgs with GitHub state
  - Organization webhook handler for member_added/member_removed cache invalidation
  - Two-tier caching (in-memory + KV) for GitHub org member lists

  Security improvements:

  - Prevent information disclosure in role permission errors
  - Validate WorkOS user ID format before database lookups
  - Skip GitHub membership verification for existing members (trusts initial verification)
  - Handle missing members:read permission gracefully with informative errors

## 0.17.0

### Minor Changes

- dfeb6da: Add job-level step tracking to check run output.
  When workflows are in progress, the check run now shows individual job status and progress instead of just workflow-level information. This provides better visibility into which specific jobs are running, completed, or failed within each workflow.

## 0.16.0

### Minor Changes

- 32433ca: Add job tracking visibility to check run output while CI is running.
  Shows a table of tracked workflows with status and duration, including stuck workflow detection.
  Background updates keep the check run current without blocking webhook responses.

## 0.15.0

### Minor Changes

- 6a70db2: Add auto-join for GitHub org members where Detent app is already installed.
  Add organization delete endpoint with soft-delete support.
  Wrap leave endpoint in transaction to prevent race conditions, add sole-member check.

### Patch Changes

- Updated dependencies [5fa4de0]
- Updated dependencies [5fa4de0]
  - @detent/healing@0.4.1
  - @detent/parser@0.5.3

## 0.14.0

### Minor Changes

- 0128b42: Add E2B sandbox service for secure AI code execution.
  Supports Python, TypeScript, and Bash with configurable timeouts, file operations, and sandbox lifecycle management.

## 0.13.0

### Minor Changes

- d25af57: Add Polar billing integration with usage-based metering support.
  Includes new billing routes, Polar service client, webhook handler for checkout events, and usage_events table for resilient event tracking.

## 0.12.2

### Patch Changes

- 7c5c1d3: Reorganize webhooks and GitHub services into modular directory structures.
  Extracts webhook handlers into individual files under `routes/webhooks/handlers/` and splits GitHub API utilities into focused modules under `services/github/`.
- Updated dependencies [18b9db1]
- Updated dependencies [2c9889d]
  - @detent/healing@0.4.0

## 0.12.1

### Patch Changes

- d226844: Use stored GitHub identity from membership records as fallback when WorkOS doesn't have GitHub linked.
  Require both providerUserId and providerUsername to avoid empty username in API calls.

## 0.12.0

### Minor Changes

- d91ffbd: Improve check suite comments with fork PR support and race protection.
  Add workflow blacklist to exclude third-party CI tools from completion checks.
  Installer auto-link now requires GitHub admin role for organization accounts.

### Patch Changes

- Updated dependencies [d91ffbd]
  - @detent/parser@0.5.2

## 0.11.0

### Minor Changes

- 4a35490: Add GitHub membership verification before granting organization access.
  Users must still be members of a GitHub organization to auto-link as owners.
  Refactor identity resolution to prefer direct GitHub token over WorkOS identities.

## 0.10.0

### Minor Changes

- bddee33: Add Sentry integration for comprehensive error tracking and observability.
  Includes structured error capture with webhook context, fingerprinting for actionable alerts,
  sensitive data scrubbing, request tracing via middleware, and unknown pattern telemetry.

### Patch Changes

- 67811d7: Improve health check error handling with database query timeout and request-level timeout middleware

## 0.9.1

### Patch Changes

- b4c69a9: Improve webhook error handling with structured responses including error codes, hints, and debugging context
- Updated dependencies [b4c69a9]
  - @detent/parser@0.5.1

## 0.9.0

### Minor Changes

- aae6802: Add GitHub OAuth token handling with automatic refresh support.
  Includes token ownership verification, format validation with character set checks,
  and a new /github-token/refresh endpoint for server-side token renewal.

## 0.8.0

### Minor Changes

- db9f7a4: Display unsupported tools in CI comments and check run output.
  Refactor check run text format to use flat file list with source badges and clickable links.

### Patch Changes

- Updated dependencies [db9f7a4]
  - @detent/parser@0.5.0

## 0.7.0

### Minor Changes

- d35c1c1: Add early check run creation on PR open and equalize admin/owner permissions.
  First GitHub admin on ownerless org now becomes owner automatically.
  Includes atomic operations to prevent race conditions and composite index for performance.

## 0.6.1

### Patch Changes

- f2b95ad: Fix orphaned check runs when webhook processing fails early.
  Retrieves stored check run ID before token retrieval and adds token recovery
  logic in the error path to ensure cleanup can happen reliably.

## 0.6.0

### Minor Changes

- 5188d02: Add errors API endpoint for fetching CI errors by commit.
  Extracts org-access verification to shared utility for reuse across routes.

## 0.5.0

### Minor Changes

- 13c1b2a: Improve check run output with source grouping and collapsible file sections.
  Errors are now organized by tool (TypeScript, Biome, etc.) with each file in a
  collapsible `<details>` block for cleaner navigation on large error counts.
- 6559092: Add organization settings as JSONB with configurable inline annotations and PR comments.
  Settings can be managed via the API with proper role-based access (owner-only for auto-join,
  admin/owner for annotations and comments). Webhook handlers now respect these settings with
  an in-memory cache for performance.

### Patch Changes

- 0c31eac: Rename APP_BASE_URL to NAVIGATOR_BASE_URL and make email sender configurable via RESEND_EMAIL_FROM
- Updated dependencies [fe49914]
  - @detent/parser@0.4.0

## 0.4.0

### Minor Changes

- f747d88: Add inline annotations to check run output with run ID based error tracking.
  Includes PR comment management for upserts, smarter annotation filtering and truncation,
  plus new database migrations for workflow run metadata and comment tracking.

### Patch Changes

- Updated dependencies [f747d88]
  - @detent/parser@0.2.0

## 0.3.0

### Minor Changes

- cf068a1: Add GitHub PR comment integration with CI error analysis.
  Includes idempotent webhook handling that waits for all workflow runs to complete,
  GitHub Check Run creation for visual status, and formatted error summaries on PRs.
  Database schema extended with PR number and check run tracking.

## 0.2.1

### Patch Changes

- b801b67: Refactor parse route into modular service architecture with dedicated modules for validation, decompression, and persistence

## 0.2.0

### Minor Changes

- 9b317d5: Add GitHub App integration with webhook handlers for installation lifecycle events.
  Includes PostgreSQL database schema (teams, projects, team_members) via Drizzle ORM,
  JWT authentication middleware for WorkOS AuthKit, and webhook signature verification.

  Add organization management endpoints (status, sync with GitHub installation state).
  Add project management routes with CRUD operations and repo synchronization.
  Add organization member management (list members, verify GitHub org membership).
  Add rate limiting middleware using Upstash Redis with IP-based and user-based limits.
  Add input validation utilities and encryption helpers for sensitive data.
  Add comprehensive test suites for auth, organizations, and webhooks.

## 0.1.0

### Minor Changes

- Add API scaffold with Hono + Cloudflare Workers

  - Add `/health` endpoint (public)
  - Add `/v1/parse` endpoint stub for log parsing (protected)
  - Add `/v1/heal` endpoint stub with SSE streaming (protected)
  - Add `X-API-Key` auth middleware (stub for WorkOS)
  - Add service wrappers for `@detent/parser` and `@detent/healing`
  - Add Drizzle schema placeholder for PlanetScale
