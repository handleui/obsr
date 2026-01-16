import { NextResponse } from "next/server";

// Health check endpoint for uptime monitoring (Better Stack, OpenStatus, etc.)
// Verifies Navigator's direct dependencies, not cross-service connectivity.
// API health is monitored separately via backend.detent.sh/health to avoid
// cascading cold start failures in serverless environments.

// Timeout constants
const CHECK_TIMEOUT_MS = 5000; // 5s per check
const REQUEST_TIMEOUT_MS = 10_000; // 10s overall

type CheckStatus = "operational" | "degraded" | "down";

interface HealthChecks {
  workos: CheckStatus;
  sentry: CheckStatus;
}

/**
 * Helper: Run a check with timeout
 */
const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Check WorkOS API connectivity
 * Uses the jwks endpoint as a lightweight, unauthenticated health probe
 */
const checkWorkOS = async (): Promise<CheckStatus> => {
  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!clientId) {
    return "down";
  }

  try {
    const response = await withTimeout(
      fetch(`https://api.workos.com/sso/jwks/${clientId}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      }),
      CHECK_TIMEOUT_MS,
      "WorkOS check timeout"
    );

    return response.ok ? "operational" : "degraded";
  } catch {
    return "down";
  }
};

/**
 * Check Sentry configuration
 * Config-only check - Sentry doesn't have a public health endpoint
 */
const checkSentry = (): CheckStatus =>
  process.env.NEXT_PUBLIC_SENTRY_DSN ? "operational" : "degraded";

/**
 * Determine overall status from individual checks
 * WorkOS is critical (blocking for auth). Sentry is informational.
 */
const computeOverallStatus = (checks: HealthChecks): CheckStatus => {
  // WorkOS is critical - Navigator can't authenticate without it
  if (checks.workos === "down") {
    return "down";
  }

  // Any degraded service (e.g., missing Sentry DSN)
  if (Object.values(checks).some((status) => status === "degraded")) {
    return "degraded";
  }

  return "operational";
};

export const GET = async () => {
  const startTime = Date.now();

  // Run checks in parallel with overall timeout
  const checksPromise = Promise.all([checkWorkOS(), checkSentry()]);

  let checks: HealthChecks;

  try {
    const [workos, sentry] = await withTimeout(
      checksPromise,
      REQUEST_TIMEOUT_MS,
      "Health check timeout"
    );

    checks = { workos, sentry };
  } catch {
    // Overall timeout - mark connectivity checks as down
    checks = {
      workos: "down",
      sentry: checkSentry(),
    };
  }

  const status = computeOverallStatus(checks);
  const httpStatus = status === "operational" ? 200 : 503;

  return NextResponse.json(
    {
      status,
      version: process.env.npm_package_version ?? "unknown",
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
      checks,
    },
    { status: httpStatus }
  );
};
