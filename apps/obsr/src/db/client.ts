import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getObsrDatabaseUrl } from "@/lib/env";
import {
  account,
  accountRelations,
  session,
  sessionRelations,
  user,
  userRelations,
  verification,
} from "./auth-schema";
import {
  issueDiagnostics,
  issueObservations,
  issues,
  vercelConnections,
  vercelSyncTargets,
} from "./schema";

const persistentDbByUrl = new Map<string, ReturnType<typeof createDb>>();
const authSchema = {
  account,
  accountRelations,
  session,
  sessionRelations,
  user,
  userRelations,
  verification,
};
const schema = {
  ...authSchema,
  issues,
  issueObservations,
  issueDiagnostics,
  vercelConnections,
  vercelSyncTargets,
};

export const createPool = (connectionString: string) => {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });

  pool.on("error", (error: unknown) => {
    console.error("[obsr-db] idle pool error:", error);
  });

  return pool;
};

export const createDb = (connectionString: string) => {
  const pool = createPool(connectionString);

  const db = drizzle({
    client: pool,
    schema,
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
