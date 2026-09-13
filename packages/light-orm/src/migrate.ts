/**
 * Bonus feature: a minimal migration generator.
 *
 * This is intentionally simple — it derives `CREATE TABLE IF NOT EXISTS`
 * statements from your model definitions so you don't have to hand-write DDL
 * that duplicates your schema. It does not diff against existing tables or
 * handle ALTER TABLE; see README "Limitations" for what a real migration
 * system would add.
 */

import postgres from "postgres";
import type { ColumnDef, ColumnType, ModelMap } from "./schema.js";
import { quoteIdent } from "./query-builder.js";

const PG_TYPE: Record<ColumnType, string> = {
  number: "double precision",
  string: "text",
  boolean: "boolean",
  date: "timestamptz",
  json: "jsonb",
};

function columnDDL(name: string, col: ColumnDef<any, any, any, any, any>): string {
  const parts = [quoteIdent(name)];

  if (col.isPrimaryKey) {
    // Auto-incrementing integer primary key.
    parts.push("serial PRIMARY KEY");
    return parts.join(" ");
  }

  parts.push(PG_TYPE[col.type as ColumnType]);
  if (!col.optional) parts.push("NOT NULL");
  if (col.isUnique) parts.push("UNIQUE");
  if (col.hasDefault) {
    parts.push(`DEFAULT ${formatDefault(col.type, col.defaultValue)}`);
  }

  return parts.join(" ");
}

function formatDefault(type: ColumnType, value: unknown): string {
  if (type === "boolean") return value ? "TRUE" : "FALSE";
  if (type === "number") return String(value);
  if (type === "date") {
    return value instanceof Date ? "now()" : `'${String(value)}'`;
  }
  if (type === "json") return `'${JSON.stringify(value)}'::jsonb`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Generates one `CREATE TABLE IF NOT EXISTS` statement per model. */
export function generateSchemaSQL(models: ModelMap): string {
  return Object.values(models)
    .map((model) => {
      const columns = Object.entries(model.shape).map(([name, col]) =>
        columnDDL(name, col as ColumnDef<any, any, any, any, any>),
      );
      return `CREATE TABLE IF NOT EXISTS ${quoteIdent(model.name)} (\n  ${columns.join(",\n  ")}\n);`;
    })
    .join("\n\n");
}

export interface MigrateOptions {
  ssl?: "require" | boolean;
}

/** Runs `generateSchemaSQL` against a live database. Idempotent (uses IF NOT EXISTS). */
export async function migrate(
  connectionString: string,
  models: ModelMap,
  options: MigrateOptions = {},
): Promise<void> {
  const sql = postgres(connectionString, { ssl: options.ssl ?? "require" });
  try {
    await sql.unsafe(generateSchemaSQL(models));
  } finally {
    await sql.end();
  }
}
