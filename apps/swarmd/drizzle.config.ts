import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./apps/swarmd/src/db/schema.ts",
  out: "./apps/swarmd/drizzle",
});
