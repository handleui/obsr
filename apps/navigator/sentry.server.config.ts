import { scrubEvent } from "@detent/sentry";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK requires namespace import pattern
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === "production",

    // SECURITY: Disable automatic PII collection (IP addresses, cookies, etc.)
    // Server-side can access sensitive request data - we scrub it via beforeSend
    sendDefaultPii: false,

    // Sample rates for performance and cost management
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.25,
    sampleRate: 1.0,

    // SECURITY: Scrub sensitive data before sending to Sentry
    // beforeSend handles error events, beforeSendTransaction handles transactions
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),

    // Spotlight for local development debugging (connects to Sentry Spotlight sidecar)
    spotlight: process.env.NODE_ENV === "development",
  });
}
