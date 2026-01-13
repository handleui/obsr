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

// Health check - verifies API and database connectivity
// Better Stack monitors this endpoint for uptime
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
  } catch {
    checks.database = "down";
    status = "down";
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
