# @detent/navigator

## 0.6.0

### Minor Changes

- a44c02e: Add dashboard route structure with organization and project authorization.
  Includes Data Access Layer (DAL) for authenticated API calls, org/project
  context providers, and auth interrupt pages (401, 403).

## 0.5.2

### Patch Changes

- 0812dd0: Add sync-user API call during auth callback for faster org auto-join.
  The call is non-blocking so auth flow continues even if sync fails.

## 0.5.1

### Patch Changes

- 1e7f542: Replace Google Fonts (Geist) with local PP Neue Montreal font.
  Adds tighter letter-spacing and updates web app metadata to proper branding.

## 0.5.0

### Minor Changes

- d25af57: Add Polar checkout integration for purchasing credits.
  Includes checkout API route and billing success page.

## 0.4.2

### Patch Changes

- 4a35490: Support GitHub classic OAuth tokens which don't have refresh tokens or expiration.
  Refactor auth callback to extract helper functions for better maintainability.

## 0.4.1

### Patch Changes

- d0cb1b8: Fix health endpoint false degraded alerts caused by Vercel cold starts.
  Removes cross-service API check that would timeout when both Navigator and API cold-started simultaneously.
  Now checks only direct dependencies (WorkOS, Sentry) with proper timeout handling.

## 0.4.0

### Minor Changes

- 67811d7: Add Sentry and Better Stack observability integration.
  Includes error boundaries, structured logging with PII scrubbing, session replay with privacy masking,
  health check endpoint, and request logging middleware for API routes.

## 0.3.0

### Minor Changes

- aae6802: Store and pass GitHub OAuth tokens to CLI during authentication flow

## 0.2.1

### Patch Changes

- d35c1c1: Fix returnTo redirect preservation after email verification in CLI auth flow

## 0.2.0

### Minor Changes

- 0c31eac: Add invitation acceptance page with token validation and error handling.
  Users can now view and accept organization invitations through a dedicated UI
  that displays invitation details, handles various error states, and redirects
  unauthenticated users to login.
