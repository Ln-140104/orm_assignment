import "dotenv/config";
import { createClient } from "@lakku/light-orm";
import { models } from "./models.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and point it at your Postgres instance.",
  );
}

export const db = createClient(models, {
  connectionString,
  // Local/dev Postgres (as in this sandbox) doesn't speak TLS; Neon/Supabase
  // require it. Toggle via env so the same code works in both.
  ssl: process.env.DATABASE_SSL === "false" ? false : "require",
  debug: process.env.DEBUG_SQL === "true",
});
