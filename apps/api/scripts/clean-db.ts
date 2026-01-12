import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/detent";
const client = new Client({ connectionString });
await client.connect();
const db = drizzle({ client });

console.log("Cleaning database...");
await db.execute(sql`TRUNCATE run_errors, runs CASCADE`);
console.log("Done! Truncated runs and run_errors tables.");

await client.end();
