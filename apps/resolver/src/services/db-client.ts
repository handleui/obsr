import { createDb } from "@detent/db";

export const createDbClient = (
  databaseUrl: string
): ReturnType<typeof createDb> =>
  createDb(databaseUrl, { context: "persistent" });
