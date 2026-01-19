import { Hono } from "hono";
import { env } from "./env.js";
import healthRoutes from "./routes/health.js";
import { startPoller, stopPoller } from "./services/poller/index.js";

const app = new Hono();

app.route("/", healthRoutes);

startPoller().catch((err) => {
  console.error(
    `[healer] Failed to start poller: ${err instanceof Error ? err.message : String(err)}`
  );
});

const shutdown = async (signal: string) => {
  console.log(`[healer] Received ${signal}, initiating graceful shutdown...`);
  try {
    await stopPoller();
    console.log("[healer] Shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error(
      `[healer] Shutdown error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default {
  port: Number(env.PORT),
  fetch: app.fetch,
};
