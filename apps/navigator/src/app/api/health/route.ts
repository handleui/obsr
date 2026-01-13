import { NextResponse } from "next/server";
import { API_BASE_URL } from "@/lib/constants";

// Health check endpoint for uptime monitoring (Better Stack, OpenStatus, etc.)
// Verifies actual service connectivity, not just config presence

// Timeout constants
const CHECK_TIMEOUT_MS = 5000; // 5s per check
const REQUEST_TIMEOUT_MS = 10_000; // 10s overall

type CheckStatus = "operational" | "degraded" | "down";

interface HealthChecks {
  workos: CheckStatus;
  api: CheckStatus;
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
 * Check Detent API connectivity
 * Calls the API health endpoint to verify backend is reachable
 */
const checkDetentAPI = async (): Promise<CheckStatus> => {
  try {
    const response = await withTimeout(
      fetch(`${API_BASE_URL}/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
      }),
      CHECK_TIMEOUT_MS,
      "API check timeout"
    );

    if (!response.ok) {
      return "down";
    }

    const data = (await response.json()) as { status?: string };
    return data.status === "operational" ? "operational" : "degraded";
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
 */
const computeOverallStatus = (checks: HealthChecks): CheckStatus => {
  // Critical dependencies that cause "down" status
  if (checks.workos === "down" || checks.api === "down") {
    return "down";
  }

  // Any degraded service causes degraded status
  if (Object.values(checks).some((status) => status === "degraded")) {
    return "degraded";
  }

  return "operational";
};

export const GET = async () => {
  const startTime = Date.now();

  // Run checks in parallel with overall timeout
  const checksPromise = Promise.all([
    checkWorkOS(),
    checkDetentAPI(),
    checkSentry(),
  ]);

  let checks: HealthChecks;

  try {
    const [workos, api, sentry] = await withTimeout(
      checksPromise,
      REQUEST_TIMEOUT_MS,
      "Health check timeout"
    );

    checks = { workos, api, sentry };
  } catch {
    // Overall timeout - mark connectivity checks as down
    checks = {
      workos: "down",
      api: "down",
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
