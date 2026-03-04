import { Hono } from "hono";
import { env } from "./env.js";
import healthRoutes from "./routes/health.js";
import queueRoutes from "./routes/queue.js";
import { startWorker, stopWorker } from "./services/worker/index.js";

const app = new Hono();

app.route("/", healthRoutes);
app.route("/queue", queueRoutes);

startWorker().catch((err: unknown) => {
  console.error(
    `[resolver] Failed to start worker: ${err instanceof Error ? err.message : String(err)}`
  );
});

const shutdown = async (signal: string) => {
  console.log(`[resolver] Received ${signal}, initiating graceful shutdown...`);
  try {
    await stopWorker();
    console.log("[resolver] Shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error(
      `[resolver] Shutdown error: ${err instanceof Error ? err.message : String(err)}`
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
