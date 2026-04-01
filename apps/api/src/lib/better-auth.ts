import { createDetentAuthFromEnv } from "@obsr/auth";
import type { Env } from "../types/env";
import { getPersistentDb } from "./db";

const cachedAuthByConnectionString = new Map<
  string,
  ReturnType<typeof createDetentAuthFromEnv>
>();

export const getBetterAuth = (env: Env) => {
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  const existing = cachedAuthByConnectionString.get(connectionString);
  if (existing) {
    return existing;
  }

  const { db } = getPersistentDb(env);
  const auth = createDetentAuthFromEnv(env, db);

  cachedAuthByConnectionString.set(connectionString, auth);
  return auth;
};

export const getBetterAuthPool = (env: Env) => getPersistentDb(env).pool;
