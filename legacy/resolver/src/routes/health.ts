import { Hono } from "hono";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

app.get("/ready", (c) => c.json({ status: "ready" }));

export default app;
