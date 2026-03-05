import { createDb } from "@detent/db";
import { createDetentAuthFromEnv } from "./create-detent-auth.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Better Auth CLI generation");
}

const { db } = createDb(databaseUrl, { context: "persistent" });

export const auth = createDetentAuthFromEnv(process.env, db);

export default auth;
