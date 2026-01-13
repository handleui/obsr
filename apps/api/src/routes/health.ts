// biome-ignore lint/performance/noNamespaceImport: Sentry SDK official pattern
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { timeout } from "hono/timeout";
import pkg from "../../package.json";
import { createDb } from "../db/client";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

// Timeout constants
const DB_CHECK_TIMEOUT_MS = 5000; // 5s for DB check specifically
const REQUEST_TIMEOUT_MS = 10_000; // 10s overall request safeguard

// Custom timeout exception for health checks - returns 503 instead of 408
const healthTimeoutException = () =>
  new HTTPException(503, {
    message: "Health check timed out",
  });

// Helper: Run database check with timeout
const checkDatabaseWithTimeout = async (
  env: Env
): Promise<"operational" | "down"> => {
  let client: Awaited<ReturnType<typeof createDb>>["client"] | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      (async () => {
        const { client: dbClient } = await createDb(env);
        client = dbClient;
        await client.query("SELECT 1");
        return "operational" as const;
      })(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Database check timeout")),
          DB_CHECK_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
    if (client) {
      await client.end();
    }
  }
};

/**
 * Report health check failure to Sentry
 * Uses warning level since failures are expected during outages
 * but we still want visibility for debugging
 */
const reportHealthFailure = (
  check: string,
  error: unknown,
  latencyMs: number
): void => {
  Sentry.withScope((scope) => {
    scope.setLevel("warning");
    scope.setTag("health.check", check);
    scope.setTag("health.status", "down");
    // Group all health check failures together
    scope.setFingerprint(["health_check", check]);
    scope.setContext("health", {
      check,
      latencyMs,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    Sentry.captureException(error);
  });
};

// Health check - verifies API and database connectivity
// OpenStatus monitors this endpoint for uptime
app.use("/", timeout(REQUEST_TIMEOUT_MS, healthTimeoutException));

app.get("/", async (c) => {
  const startTime = Date.now();

  const checks: {
    database: "operational" | "down";
  } = {
    database: "down",
  };

  let status: "operational" | "down" = "operational";

  try {
    checks.database = await checkDatabaseWithTimeout(c.env);
  } catch (error) {
    checks.database = "down";
    status = "down";
    reportHealthFailure("database", error, Date.now() - startTime);
  }

  return c.json(
    {
      status,
      version: pkg.version,
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - startTime,
      checks,
    },
    status === "operational" ? 200 : 503
  );
});

export default app;
