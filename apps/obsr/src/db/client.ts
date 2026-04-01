import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getObsrDatabaseUrl } from "@/lib/env";
import { analyses, analysisDiagnostics } from "./schema";

const persistentDbByUrl = new Map<string, ReturnType<typeof createDb>>();

export const createDb = (connectionString: string) => {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });

  pool.on("error", (error: unknown) => {
    console.error("[obsr-db] idle pool error:", error);
  });

  const db = drizzle({
    client: pool,
    schema: {
      analyses,
      analysisDiagnostics,
    },
  });
  return { db, pool };
};

export type ObsrDb = ReturnType<typeof createDb>["db"];

export const getDb = () => {
  const connectionString = getObsrDatabaseUrl();
  const existing = persistentDbByUrl.get(connectionString);
  if (existing) {
    return existing;
  }

  const resources = createDb(connectionString);
  persistentDbByUrl.set(connectionString, resources);
  return resources;
};
