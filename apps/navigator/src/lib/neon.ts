import "server-only";

import { createDb } from "@detent/db";

const globalForDb = globalThis as unknown as {
  __neonDb?: ReturnType<typeof createDb>;
};

export const getNeonDb = () => {
  if (!globalForDb.__neonDb) {
    const url = process.env.NEON_DATABASE_URL;
    if (!url) {
      throw new Error("NEON_DATABASE_URL is required");
    }
    globalForDb.__neonDb = createDb(url, { context: "persistent" });
  }
  return globalForDb.__neonDb;
};
