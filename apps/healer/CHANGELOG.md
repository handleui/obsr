# @detent/healer

## 0.2.0

### Minor Changes

- 89239c2: Add GitHub status updates when heals complete.
  The healer now updates check runs and posts PR comments when heals succeed or fail, providing clear feedback in GitHub. Includes configurable concurrency limit and retry logic for API calls.

## 0.1.1

### Patch Changes

- 00c1fe2: Remove VERCEL_OIDC_TOKEN environment variable support.
  Vercel sandbox authentication now requires VERCEL_TOKEN with VERCEL_TEAM_ID and VERCEL_PROJECT_ID.
- Updated dependencies [00c1fe2]
  - @detent/sandbox@0.1.1
