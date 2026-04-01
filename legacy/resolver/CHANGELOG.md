# @obsr/resolver

## 1.0.0

### Major Changes

- 565831f: First stable resolver major after the healing-to-resolving migration.
  Renames service interfaces and resolve lifecycle behavior across queue handling, worker orchestration, and webhook dispatch integrations.

## 0.2.0

### Minor Changes

- 89239c2: Add GitHub status updates when resolves complete.
  The Resolver now updates check runs and posts PR comments when resolves succeed or fail, providing clear feedback in GitHub. Includes configurable concurrency limit and retry logic for API calls.

## 0.1.1

### Patch Changes

- 00c1fe2: Remove VERCEL_OIDC_TOKEN environment variable support.
  Vercel sandbox authentication now requires VERCEL_TOKEN with VERCEL_TEAM_ID and VERCEL_PROJECT_ID.
- Updated dependencies [00c1fe2]
  - @obsr/sandbox@0.1.1
