import { createDb, type Db } from "@detent/db";
import type { Pool } from "@neondatabase/serverless";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

export const createDbClient = (databaseUrl: string): { db: Db; pool: Pool } => {
  const { db, pool } = createDb(databaseUrl);
  return { db, pool };
};
