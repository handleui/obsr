import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DIRECT_URL ??
      process.env.DATABASE_URL ??
      process.env.OBSR_DATABASE_URL ??
      "",
  },
  migrations: {
    table: "__drizzle_migrations",
    schema: "public",
  },
});
