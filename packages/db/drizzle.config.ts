import { defineConfig } from "drizzle-kit";
import { parseDatabaseEnvironment } from "@repo/validation/environment";
import { loadRepositoryEnvironment } from "@repo/validation/environment-loader";

loadRepositoryEnvironment();

const environment = parseDatabaseEnvironment();

export default defineConfig({
  out: "./drizzle",
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: environment.DATABASE_URL,
  },
});
