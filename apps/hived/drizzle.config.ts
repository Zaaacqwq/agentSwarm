import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./apps/hived/src/db/schema.ts",
  out: "./apps/hived/drizzle",
});
