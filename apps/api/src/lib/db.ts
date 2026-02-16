import { createDb } from "@detent/db";
import type { Env } from "../types/env.js";

export const getDb = (env: Pick<Env, "HYPERDRIVE" | "DATABASE_URL">) => {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  return createDb(connectionString);
};
