import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "node:process";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { prepare: false });
  return drizzle({ client: client, schema });
}

let database: Database | undefined;

export function getDb(): Database {
  if (!database) {
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required before database access.");
    database = createDatabase(databaseUrl);
  }
  return database;
}
