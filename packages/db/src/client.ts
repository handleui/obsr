import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// biome-ignore lint/performance/noNamespaceImport: Drizzle requires namespace import for schema
import * as schema from "./schema/index.js";

export interface CreateDbOptions {
  // "serverless" (Cloudflare Workers): per-request pool, destroyed after request
  // "persistent" (Next.js): singleton pool, lives for process lifetime
  context?: "serverless" | "persistent";
}

export const createDb = (databaseUrl: string, options?: CreateDbOptions) => {
  const context = options?.context ?? "serverless";

  const poolConfig =
    context === "persistent"
      ? { max: 10, idleTimeoutMillis: 30_000 }
      : { max: 3, idleTimeoutMillis: 500 };

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    ...poolConfig,
  });
  pool.on("error", (err: unknown) => {
    console.error("[db] idle pool client error:", err);
  });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
};

export type Db = ReturnType<typeof createDb>["db"];
