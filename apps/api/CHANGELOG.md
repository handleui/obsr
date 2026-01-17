# @detent/api

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
