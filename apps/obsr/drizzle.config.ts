import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.OBSR_DATABASE_URL ?? "",
  },
  migrations: {
    table: "__drizzle_migrations",
    schema: "public",
  },
});
