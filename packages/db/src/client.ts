import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

// biome-ignore lint/performance/noNamespaceImport: Drizzle requires namespace import for schema
import * as schema from "./schema/index.js";

export const createDb = (databaseUrl: string) => {
  const pool = new Pool({ connectionString: databaseUrl });
  pool.on("error", (err: unknown) => {
    console.error("[db] idle pool client error:", err);
  });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
};

export type Db = ReturnType<typeof createDb>["db"];
