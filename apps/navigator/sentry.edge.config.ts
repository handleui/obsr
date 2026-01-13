import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/nextjs";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK requires namespace import pattern
import * as Sentry from "@sentry/nextjs";
import { scrubObject, scrubString } from "./src/lib/scrub";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/**
 * Headers that should never be sent to error tracking
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
]);

/**
 * Scrub request headers, removing sensitive ones
 */
const scrubHeaders = (
  headers: Record<string, string>
): Record<string, string> => {
  const safeHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!(SENSITIVE_HEADERS.has(lowerKey) || lowerKey.includes("token"))) {
      safeHeaders[key] = typeof value === "string" ? scrubString(value) : "";
    }
  }
  return safeHeaders;
};

/**
 * Scrub request body data
 */
const scrubRequestData = (
  data: NonNullable<NonNullable<ErrorEvent["request"]>["data"]>
): NonNullable<NonNullable<ErrorEvent["request"]>["data"]> => {
  if (typeof data === "string") {
    return scrubString(data);
  }
  return scrubObject(data as Record<string, unknown>);
};

/**
 * Scrub request data (URL, query string, headers, cookies, body)
 */
const scrubRequest = (request: ErrorEvent["request"]): void => {
  if (!request) {
    return;
  }

  if (request.url) {
    request.url = scrubString(request.url);
  }
  if (request.query_string) {
    const qs =
      typeof request.query_string === "string"
        ? request.query_string
        : String(request.query_string);
    request.query_string = scrubString(qs);
  }
  if (request.headers) {
    request.headers = scrubHeaders(request.headers);
  }
  if (request.cookies) {
    request.cookies = {};
  }
  if (request.data) {
    request.data = scrubRequestData(request.data);
  }
};

/**
 * Scrub breadcrumb data
 */
const scrubBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb => {
  if (breadcrumb.message) {
    breadcrumb.message = scrubString(breadcrumb.message);
  }
  if (breadcrumb.data) {
    breadcrumb.data = scrubObject(breadcrumb.data as Record<string, unknown>);
  }
  return breadcrumb;
};

/**
 * Scrub sensitive data from Sentry events before sending
 */
const beforeSend = (event: ErrorEvent, _hint: EventHint): ErrorEvent | null => {
  scrubRequest(event.request);

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }

  if (event.extra) {
    event.extra = scrubObject(event.extra);
  }

  if (event.tags) {
    event.tags = scrubObject(event.tags) as Record<string, string>;
  }

  // Remove user PII if present (keep only anonymized user ID)
  if (event.user) {
    event.user.email = undefined;
    event.user.username = undefined;
    event.user.ip_address = undefined;
  }

  return event;
};

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === "production",

    // SECURITY: Disable automatic PII collection (IP addresses, cookies, etc.)
    // Edge runtime can access sensitive request data - we scrub it via beforeSend
    sendDefaultPii: false,

    // Sample rates for performance and cost management
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.25,
    sampleRate: 1.0,

    // SECURITY: Scrub sensitive data before sending to Sentry
    beforeSend,
  });
}
