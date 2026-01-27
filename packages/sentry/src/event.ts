/**
 * Sentry event scrubbing utilities
 * SECURITY: Scrubs sensitive data from events before sending to Sentry
 *
 * These utilities use loose typing to be compatible with different Sentry SDK versions
 * (@sentry/nextjs, @sentry/cloudflare, @sentry/node) which have varying type definitions.
 */

import { scrubHeaders } from "./headers.js";
import { scrubObject, scrubString } from "./scrub.js";

// biome-ignore lint/suspicious/noExplicitAny: Required for cross-SDK compatibility
type AnyObject = Record<string, any>;

/**
 * Scrub request body data
 */
export const scrubRequestData = (data: unknown): unknown => {
  if (typeof data === "string") {
    return scrubString(data);
  }
  if (data && typeof data === "object") {
    return scrubObject(data as Record<string, unknown>);
  }
  return data;
};

/**
 * Scrub query string, handling various formats
 * Performance: Uses for loop instead of map for array format
 */
const scrubQueryString = (qs: unknown): unknown => {
  if (typeof qs === "string") {
    return scrubString(qs);
  }
  if (Array.isArray(qs)) {
    // Handle [string, string][] format used by some Sentry SDKs
    const result = new Array(qs.length);
    for (let i = 0; i < qs.length; i++) {
      const [key, value] = qs[i];
      result[i] = [key, scrubString(String(value))];
    }
    return result;
  }
  if (qs && typeof qs === "object") {
    return scrubObject(qs as Record<string, unknown>);
  }
  return qs;
};

/**
 * Scrub request data (URL, query string, headers, cookies, body)
 * Mutates the request object in place for efficiency
 */
export const scrubRequest = (request: AnyObject | undefined): void => {
  if (!request) {
    return;
  }

  if (request.url && typeof request.url === "string") {
    request.url = scrubString(request.url);
  }
  if (request.query_string !== undefined) {
    request.query_string = scrubQueryString(request.query_string);
  }
  if (request.headers && typeof request.headers === "object") {
    request.headers = scrubHeaders(request.headers as Record<string, string>);
  }
  if (request.cookies) {
    request.cookies = {};
  }
  if (request.data !== undefined) {
    request.data = scrubRequestData(request.data);
  }
};

/**
 * Scrub breadcrumb data
 */
export const scrubBreadcrumb = (breadcrumb: AnyObject): AnyObject => {
  if (breadcrumb.message && typeof breadcrumb.message === "string") {
    breadcrumb.message = scrubString(breadcrumb.message);
  }
  if (breadcrumb.data && typeof breadcrumb.data === "object") {
    breadcrumb.data = scrubObject(breadcrumb.data as Record<string, unknown>);
  }
  return breadcrumb;
};

/**
 * Scrub user PII, keeping only anonymized user ID
 */
export const scrubUser = (user: AnyObject | undefined): void => {
  if (!user) {
    return;
  }
  user.email = undefined;
  user.username = undefined;
  user.ip_address = undefined;
};

/**
 * Scrub exception values (error messages in stack traces)
 * SECURITY: Error messages may contain sensitive data like URLs, tokens, etc.
 * @internal
 */
const scrubException = (exception: AnyObject | undefined): void => {
  if (!exception) {
    return;
  }

  const values = exception.values;
  if (!(values && Array.isArray(values))) {
    return;
  }

  for (const value of values) {
    // Scrub error message
    if (typeof value.value === "string") {
      value.value = scrubString(value.value);
    }
    // Scrub stack frame filenames (may contain paths with sensitive data)
    const stacktrace = value.stacktrace;
    if (stacktrace?.frames && Array.isArray(stacktrace.frames)) {
      for (const frame of stacktrace.frames) {
        if (typeof frame.filename === "string") {
          frame.filename = scrubString(frame.filename);
        }
        if (typeof frame.abs_path === "string") {
          frame.abs_path = scrubString(frame.abs_path);
        }
      }
    }
  }
};

/**
 * Scrub contexts object (may contain OS info, device info, custom context)
 * SECURITY: Contexts can contain environment variables, file paths, etc.
 * @internal
 */
const scrubContexts = (contexts: AnyObject | undefined): void => {
  if (!contexts || typeof contexts !== "object") {
    return;
  }

  for (const key of Object.keys(contexts)) {
    const context = contexts[key];
    if (context && typeof context === "object") {
      contexts[key] = scrubObject(context as Record<string, unknown>);
    }
  }
};

/**
 * Scrub all sensitive data from a Sentry event
 * Mutates the event object in place and returns it
 *
 * Works with any Sentry event type (ErrorEvent, TransactionEvent, etc.)
 * by using duck typing for maximum compatibility across SDK versions.
 *
 * SECURITY: Scrubs all known locations where sensitive data can appear:
 * - request (URL, headers, body, cookies, query string)
 * - breadcrumbs (messages, data)
 * - extra (custom data)
 * - tags (custom tags)
 * - user (email, username, IP)
 * - message (top-level error message)
 * - exception (error messages, stack trace paths)
 * - contexts (OS info, device info, custom contexts)
 *
 * Performance: Short-circuits on empty/missing data to avoid unnecessary work
 *
 * @param event - The Sentry event to scrub (mutated in place)
 * @returns The same event object with sensitive data removed
 */
export const scrubEvent = <T>(event: T): T => {
  // Short-circuit if event is null/undefined
  if (!event) {
    return event;
  }

  const e = event as AnyObject;

  // Scrub top-level message (can contain sensitive data)
  if (typeof e.message === "string") {
    e.message = scrubString(e.message);
  }

  if (e.request) {
    scrubRequest(e.request);
  }

  // Scrub exception values (error messages in stack traces)
  if (e.exception) {
    scrubException(e.exception);
  }

  // Only process breadcrumbs if array has items
  const breadcrumbs = e.breadcrumbs;
  if (breadcrumbs && Array.isArray(breadcrumbs) && breadcrumbs.length > 0) {
    for (const crumb of breadcrumbs) {
      scrubBreadcrumb(crumb);
    }
  }

  if (e.extra && typeof e.extra === "object") {
    e.extra = scrubObject(e.extra as Record<string, unknown>);
  }

  if (e.tags && typeof e.tags === "object") {
    e.tags = scrubObject(e.tags as Record<string, unknown>);
  }

  if (e.user) {
    scrubUser(e.user);
  }

  // Scrub contexts (OS info, device info, custom contexts)
  if (e.contexts) {
    scrubContexts(e.contexts);
  }

  return event;
};

/**
 * Create a beforeSend handler that scrubs sensitive data
 * Returns a function compatible with Sentry's beforeSend option
 *
 * Usage:
 * ```ts
 * import { createBeforeSendHandler } from "@detent/sentry";
 *
 * Sentry.init({
 *   beforeSend: createBeforeSendHandler(),
 * });
 * ```
 */
export const createBeforeSendHandler =
  <T>() =>
  (event: T, _hint?: unknown): T | null => {
    return scrubEvent(event);
  };

/**
 * Scrub a single span in a transaction
 * @internal
 */
const scrubSpan = (span: AnyObject): void => {
  if (typeof span.description === "string") {
    span.description = scrubString(span.description);
  }
  if (span.data && typeof span.data === "object") {
    span.data = scrubObject(span.data as Record<string, unknown>);
  }
};

/**
 * Create a beforeSendTransaction handler that scrubs sensitive data from transactions
 * Transactions can contain sensitive data in URLs, route parameters, and spans
 *
 * Usage:
 * ```ts
 * import { createBeforeSendTransactionHandler } from "@detent/sentry";
 *
 * Sentry.init({
 *   beforeSendTransaction: createBeforeSendTransactionHandler(),
 * });
 * ```
 */
export const createBeforeSendTransactionHandler =
  <T>() =>
  (event: T, _hint?: unknown): T | null => {
    if (!event) {
      return event;
    }

    const e = event as AnyObject;

    // Scrub transaction name (may contain sensitive route params)
    if (typeof e.transaction === "string") {
      e.transaction = scrubString(e.transaction);
    }

    // Scrub spans which may contain sensitive URLs or data
    const spans = e.spans;
    if (spans && Array.isArray(spans) && spans.length > 0) {
      for (const span of spans) {
        scrubSpan(span);
      }
    }

    // Use common scrubEvent for request, breadcrumbs, extra, tags, user
    return scrubEvent(event);
  };

/**
 * Helper to scrub request/response body
 * @internal
 */
const scrubBody = (body: unknown): unknown => {
  if (typeof body === "string") {
    return scrubString(body);
  }
  if (body && typeof body === "object") {
    return scrubObject(body as Record<string, unknown>);
  }
  return body;
};

/**
 * Scrub network request data in replay events
 * @internal
 */
const scrubReplayRequest = (request: AnyObject): void => {
  if (typeof request.url === "string") {
    request.url = scrubString(request.url);
  }
  if (request.headers && typeof request.headers === "object") {
    request.headers = scrubHeaders(request.headers as Record<string, string>);
  }
  if (request.body !== undefined) {
    request.body = scrubBody(request.body);
  }
};

/**
 * Scrub network response data in replay events
 * @internal
 */
const scrubReplayResponse = (response: AnyObject): void => {
  if (response.headers && typeof response.headers === "object") {
    response.headers = scrubHeaders(response.headers as Record<string, string>);
  }
  if (response.body !== undefined) {
    response.body = scrubBody(response.body);
  }
};

/**
 * Scrub Session Replay recording events (network requests, console logs)
 * Use with replayIntegration's beforeAddRecordingEvent option
 *
 * Performance: Uses helper function to reduce code duplication and
 * short-circuits on missing data
 *
 * Usage:
 * ```ts
 * import { scrubReplayEvent } from "@detent/sentry";
 *
 * Sentry.replayIntegration({
 *   beforeAddRecordingEvent: scrubReplayEvent,
 * });
 * ```
 */
export const scrubReplayEvent = <T extends AnyObject>(event: T): T | null => {
  const data = event.data;
  if (!data) {
    return event;
  }

  const payload = data.payload as AnyObject | undefined;
  if (!payload) {
    return event;
  }

  // Handle network request/response data using extracted helpers
  if (payload.request) {
    scrubReplayRequest(payload.request);
  }
  if (payload.response) {
    scrubReplayResponse(payload.response);
  }

  // Handle console log messages (breadcrumb tag)
  if (data.tag === "breadcrumb") {
    if (typeof payload.message === "string") {
      payload.message = scrubString(payload.message);
    }
    if (payload.data && typeof payload.data === "object") {
      payload.data = scrubObject(payload.data as Record<string, unknown>);
    }
  }

  return event;
};
