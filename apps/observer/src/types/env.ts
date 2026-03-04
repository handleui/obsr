import type {
  Hyperdrive,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";

export interface Env {
  GITHUB_APP_ID: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_CLIENT_SECRET?: string;

  WORKOS_CLIENT_ID: string;
  WORKOS_API_KEY: string;

  ALLOWED_REDIRECT_URIS?: string;
  ALLOWED_ORIGINS?: string;
  ENCRYPTION_KEY?: string;

  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;

  "detent-idempotency": KVNamespace;

  OPENSTATUS_SLUG?: string;

  RESEND_API_KEY: string;
  RESEND_EMAIL_FROM: string;

  APP_BASE_URL?: string;
  NAVIGATOR_BASE_URL?: string;

  SENTRY_DSN?: string;

  SANDBOX_PROVIDER?: string;
  DAYTONA_API_KEY?: string;
  DAYTONA_API_URL?: string;
  DAYTONA_TARGET?: string;
  DAYTONA_ORGANIZATION_ID?: string;
  DAYTONA_JWT_TOKEN?: string;
  E2B_API_KEY?: string;
  VERCEL_TOKEN?: string;
  VERCEL_TEAM_ID?: string;
  VERCEL_PROJECT_ID?: string;

  CF_VERSION_METADATA?: {
    id: string;
    tag: string;
    timestamp: string;
  };

  POLAR_ACCESS_TOKEN?: string;
  POLAR_ORGANIZATION_ID?: string;
  POLAR_WEBHOOK_SECRET?: string;

  MODAL_WEBHOOK_SECRET?: string;
  MODAL_EXECUTOR_URL?: string;

  CONVEX_URL: string;
  CONVEX_SERVICE_TOKEN: string;

  AI_GATEWAY_API_KEY: string;

  DATABASE_URL: string;
  HYPERDRIVE?: Hyperdrive;

  LOGS_BUCKET: R2Bucket;

  UPSTASH_QSTASH_URL?: string;
  UPSTASH_QSTASH_TOKEN?: string;
  UPSTASH_QSTASH_PUBLISH_URL?: string;
  RESOLVER_WEBHOOK_URL?: string;
}
