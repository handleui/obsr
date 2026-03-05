import { createDb } from "@detent/db";
import type { Env } from "../types/env.js";

const persistentDbByConnectionString = new Map<
  string,
  ReturnType<typeof createDb>
>();

const getConnectionString = (env: Pick<Env, "HYPERDRIVE" | "DATABASE_URL">) =>
  env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;

export const getDb = (env: Pick<Env, "HYPERDRIVE" | "DATABASE_URL">) => {
  return createDb(getConnectionString(env));
};

export const getPersistentDb = (
  env: Pick<Env, "HYPERDRIVE" | "DATABASE_URL">
) => {
  const connectionString = getConnectionString(env);
  const existing = persistentDbByConnectionString.get(connectionString);
  if (existing) {
    return existing;
  }

  const resources = createDb(connectionString, { context: "persistent" });
  persistentDbByConnectionString.set(connectionString, resources);
  return resources;
};
