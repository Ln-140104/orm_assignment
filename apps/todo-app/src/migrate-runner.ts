import "dotenv/config";
import { migrate } from "@lakku/light-orm";
import { models } from "./models.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
}

migrate(connectionString, models, {
  ssl: process.env.DATABASE_SSL === "false" ? false : "require",
})
  .then(() => {
    console.log("✅ Schema created/verified for models:", Object.keys(models).join(", "));
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  });
