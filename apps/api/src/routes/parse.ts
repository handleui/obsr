import { Hono } from "hono";
import { parseService } from "../services/parse";
import {
  type ParseRequest,
  ParseTimeoutError,
  ValidationError,
} from "../services/parse/types";
import type { Env } from "../types/env";

const app = new Hono<{ Bindings: Env }>();

// POST /parse - Parse CI logs and extract errors
app.post("/", async (c) => {
  // Parse JSON body
  let body: ParseRequest;
  try {
    body = await c.req.json<ParseRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Call service to parse and persist
  try {
    const result = await parseService.parseAndPersist(body, c.env);
    return c.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return c.json({ error: error.message }, 400);
    }
    if (error instanceof ParseTimeoutError) {
      return c.json({ error: "Request timeout: parsing took too long" }, 408);
    }
    console.error("[parse] unexpected error", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default app;
