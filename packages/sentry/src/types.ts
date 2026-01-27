/**
 * Runtime-agnostic Sentry types for use across different SDKs
 * (@sentry/nextjs, @sentry/cloudflare, @sentry/node)
 *
 * These interfaces match the common shape used by all Sentry JS SDKs,
 * allowing scrubbing utilities to work without SDK-specific dependencies.
 */

export interface SentryRequest {
  url?: string;
  query_string?: string | Record<string, string>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  data?: string | Record<string, unknown>;
}

export interface SentryBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

export interface SentryUser {
  id?: string;
  email?: string | undefined;
  username?: string | undefined;
  ip_address?: string | undefined;
}

export interface SentryEvent {
  request?: SentryRequest;
  breadcrumbs?: SentryBreadcrumb[];
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
  user?: SentryUser;
}
