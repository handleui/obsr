import { createDetentAuthFromEnv } from "@detent/auth";
import type { Env } from "../types/env";
import { getPersistentDb } from "./db";

let cachedAuth: ReturnType<typeof createDetentAuthFromEnv> | null = null;

export const getBetterAuth = (env: Env) => {
  if (cachedAuth) {
    return cachedAuth;
  }

  const { db } = getPersistentDb(env);

  cachedAuth = createDetentAuthFromEnv(env, db);
  return cachedAuth;
};

export const getBetterAuthPool = (env: Env) => getPersistentDb(env).pool;
