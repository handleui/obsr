import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/schema/runs.ts",
    "./src/schema/errors.ts",
    "./src/schema/usage.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  migrations: {
    table: "__drizzle_migrations",
    schema: "public",
  },
});
