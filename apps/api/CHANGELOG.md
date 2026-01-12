# @detent/api

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
