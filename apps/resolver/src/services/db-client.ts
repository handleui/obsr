import { createDb } from "@obsr/db";

export const createDbClient = (
  databaseUrl: string
): ReturnType<typeof createDb> =>
  createDb(databaseUrl, { context: "persistent" });
