"use client";

import { captureException } from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Global error boundary for the root layout.
 * This catches errors that bubble up past all other error boundaries.
 * Follows Sentry's recommended minimal pattern - error capture happens here,
 * detailed logging should be handled at the source of the error.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, {
      tags: {
        errorBoundary: "global",
        severity: "critical",
      },
      extra: {
        digest: error.digest,
      },
    });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <div
          style={{
            display: "flex",
            minHeight: "100vh",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
          }}
        >
          <h1
            style={{
              fontWeight: "bold",
              fontSize: "1.5rem",
              color: "#ef4444",
              margin: 0,
            }}
          >
            Something went wrong
          </h1>
          <p style={{ marginTop: "1rem", color: "#4b5563" }}>
            A critical error occurred. Please try again.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              borderRadius: "0.375rem",
              backgroundColor: "#2563eb",
              padding: "0.5rem 1rem",
              color: "white",
              border: "none",
              cursor: "pointer",
              fontSize: "1rem",
            }}
            type="button"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
