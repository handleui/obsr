# @detent/navigator

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
