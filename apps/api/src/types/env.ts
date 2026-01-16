import type { Hyperdrive, KVNamespace } from "@cloudflare/workers-types";

// Cloudflare Worker environment bindings
// Set these via: npx wrangler secret put <NAME>

export interface Env {
  // GitHub App credentials
  GITHUB_APP_ID: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  // GitHub App Client Secret (for OAuth token refresh)
  // Required to refresh user OAuth tokens when they expire
  GITHUB_CLIENT_SECRET?: string;

  // Database connection via Cloudflare Hyperdrive
  HYPERDRIVE: Hyperdrive;
  // Fallback for local dev / migrations
  DATABASE_URL?: string;

  // WorkOS User Management credentials
  WORKOS_CLIENT_ID: string;
  WORKOS_API_KEY: string; // For fetching user details and identities

  // OAuth configuration (optional)
  ALLOWED_REDIRECT_URIS?: string; // Comma-separated list of allowed redirect URIs

  // CORS configuration (optional)
  ALLOWED_ORIGINS?: string; // Comma-separated list of allowed CORS origins

  // Encryption key for sensitive data (GitLab tokens, etc.)
  // Generate with: openssl rand -base64 32
  ENCRYPTION_KEY?: string;

  // Upstash Redis for rate limiting
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;

  // KV for webhook idempotency
  "detent-idempotency": KVNamespace;

  // OpenStatus monitoring (optional)
  // Your OpenStatus status page slug for public status checks
  OPENSTATUS_SLUG?: string;

  // Email (Resend) configuration
  RESEND_API_KEY: string;
  // Sender address for emails, e.g., "Detent <noreply@detent.dev>"
  RESEND_EMAIL_FROM: string;

  // Navigator (web app) base URL for invitation links
  // e.g., https://navigator.detent.sh
  NAVIGATOR_BASE_URL: string;

  // Sentry error monitoring
  SENTRY_DSN?: string;

  // E2B sandbox for AI code execution
  E2B_API_KEY: string;

  // Cloudflare version metadata for Sentry release tracking
  CF_VERSION_METADATA?: {
    id: string;
    tag: string;
    timestamp: string;
  };

  // Polar billing
  POLAR_ACCESS_TOKEN?: string;
  POLAR_ORGANIZATION_ID?: string;
  POLAR_WEBHOOK_SECRET?: string;
}
