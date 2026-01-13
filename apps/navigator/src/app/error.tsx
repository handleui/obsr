"use client";

import { LogLevel } from "@logtail/next";
import { useLogger } from "@logtail/next/hooks";
import { captureException } from "@sentry/nextjs";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { scrubStringNullable } from "../lib/scrub";

/**
 * Sanitize URL by removing query parameters that might contain sensitive data
 * SECURITY: Only keeps the pathname, removes all query params from logged URLs
 */
const sanitizeUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    // Only return origin + pathname, drop all query params
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid-url]";
  }
};

/**
 * Classify error type for better alerting and filtering in Better Stack
 */
const classifyError = (
  error: Error
): { type: string; severity: "critical" | "error" | "warning" } => {
  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  if (message.includes("network") || message.includes("fetch")) {
    return { type: "network_error", severity: "warning" };
  }
  if (message.includes("unauthorized") || message.includes("403")) {
    return { type: "auth_error", severity: "error" };
  }
  if (message.includes("not found") || message.includes("404")) {
    return { type: "not_found", severity: "warning" };
  }
  if (name.includes("type") || name.includes("reference")) {
    return { type: "runtime_error", severity: "critical" };
  }
  if (message.includes("timeout")) {
    return { type: "timeout_error", severity: "error" };
  }
  return { type: "unhandled_error", severity: "error" };
};

const getStatusCode = (error: Error): number => {
  const message = error.message.toLowerCase();
  if (message.includes("not found") || message.includes("invalid url")) {
    return 404;
  }
  if (message.includes("unauthorized")) {
    return 401;
  }
  if (message.includes("forbidden") || message.includes("403")) {
    return 403;
  }
  return 500;
};

/**
 * Sanitize error message to remove potential PII
 * SECURITY: Scrub sensitive patterns from error messages before logging
 */
const sanitizeErrorMessage = (message: string): string => {
  return scrubStringNullable(message) ?? "Unknown error";
};

const ErrorContent = ({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const log = useLogger({ source: "error.tsx" });
  const status = getStatusCode(error);
  const { type: errorType, severity } = classifyError(error);

  useEffect(() => {
    // SECURITY: Scrub search params before sending - they may contain tokens/secrets
    const hasSearchParams = searchParams && searchParams.toString().length > 0;

    captureException(error, {
      tags: {
        errorType,
        severity,
        statusCode: status,
      },
      extra: {
        pathname,
        // SECURITY: Only indicate presence of params, don't send actual values
        hasSearchParams,
        digest: error.digest,
      },
    });

    // SECURITY: Sanitize all data before sending to Better Stack
    const sanitizedHost =
      typeof window !== "undefined"
        ? sanitizeUrl(window.location.href)
        : undefined;

    log.logHttpRequest(
      LogLevel.error,
      `[${severity.toUpperCase()}] ${sanitizeErrorMessage(error.message)}`,
      {
        host: sanitizedHost ?? "",
        path: pathname,
        statusCode: status,
      },
      {
        errorType,
        severity,
        error: error.name,
        // SECURITY: Don't send error.cause as it may contain sensitive context
        digest: error.digest,
        // SECURITY: Only log presence of search params, not their values
        hasSearchParams,
        // SECURITY: Don't send full userAgent (fingerprinting concern)
        timestamp: new Date().toISOString(),
      }
    );
  }, [error, log, pathname, status, errorType, severity, searchParams]);

  const isUserFacing = severity !== "critical";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="font-bold text-2xl text-red-500">Something went wrong</h1>
      <p className="mt-4 text-gray-600">
        {isUserFacing ? error.message : "An unexpected error occurred."}
      </p>
      <button
        className="mt-6 rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        onClick={reset}
        type="button"
      >
        Try again
      </button>
    </div>
  );
};

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen flex-col items-center justify-center p-8">
          <h1 className="font-bold text-2xl text-red-500">
            Something went wrong
          </h1>
        </div>
      }
    >
      <ErrorContent error={error} reset={reset} />
    </Suspense>
  );
}
