/**
 * Query builder.
 *
 * Two responsibilities live here, deliberately kept separate:
 *  1. The *typed* shape of query inputs (WhereInput, FindManyArgs, ...),
 *     which is what gives developers autocomplete and compile errors.
 *  2. The *untyped* SQL generation that turns those inputs into a
 *     parameterized query string + values array — never string-interpolated,
 *     so there is no SQL injection surface.
 */

import type { ModelDef, InferRow } from "./schema.js";

// --- Typed query inputs -----------------------------------------------------

/** Per-field comparison operators, narrowed by the field's own JS type. */
type FieldFilter<TValue> = TValue extends number
  ? {
      equals?: TValue;
      not?: TValue;
      gt?: TValue;
      gte?: TValue;
      lt?: TValue;
      lte?: TValue;
      in?: TValue[];
    }
  : TValue extends string
    ? {
        equals?: TValue;
        not?: TValue;
        contains?: TValue;
        startsWith?: TValue;
        endsWith?: TValue;
        in?: TValue[];
      }
    : TValue extends boolean
      ? { equals?: TValue; not?: TValue }
      : { equals?: TValue; not?: TValue };

/**
 * `where` accepts either a bare value (shorthand for `equals`) or an
 * operator object, per field — e.g. `{ completed: false }` or
 * `{ title: { contains: "assignment" } }`.
 */
export type WhereInput<M extends ModelDef<any, any>> = {
  [K in keyof InferRow<M>]?: InferRow<M>[K] | FieldFilter<InferRow<M>[K]>;
};

export type OrderByInput<M extends ModelDef<any, any>> = Partial<
  Record<keyof InferRow<M>, "asc" | "desc">
>;

export interface FindManyArgs<M extends ModelDef<any, any>> {
  where?: WhereInput<M>;
  orderBy?: OrderByInput<M>;
  take?: number;
  skip?: number;
}

export interface FindFirstArgs<M extends ModelDef<any, any>>
  extends Omit<FindManyArgs<M>, "take" | "skip"> {}

// --- SQL generation ----------------------------------------------------------

export interface CompiledClause {
  sql: string;
  values: unknown[];
}

const OPERATOR_SQL: Record<string, string> = {
  equals: "=",
  not: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/** Quotes an identifier (table/column name) to protect against reserved words. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Compiles a WhereInput into a `WHERE ...` clause (or "" if empty) plus its
 * bound parameter values, starting parameter numbering at `startIndex`.
 */
export function compileWhere(
  where: Record<string, unknown> | undefined,
  startIndex = 1,
): CompiledClause {
  if (!where || Object.keys(where).length === 0) {
    return { sql: "", values: [] };
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = startIndex;

  for (const [field, rawFilter] of Object.entries(where)) {
    if (rawFilter === undefined) continue;
    const column = quoteIdent(field);

    const isOperatorObject =
      rawFilter !== null &&
      typeof rawFilter === "object" &&
      !(rawFilter instanceof Date) &&
      !Array.isArray(rawFilter);

    if (!isOperatorObject) {
      // Shorthand: `{ completed: false }` -> `"completed" = $1`
      conditions.push(`${column} = $${paramIndex++}`);
      values.push(rawFilter);
      continue;
    }

    for (const [op, opValue] of Object.entries(rawFilter as Record<string, unknown>)) {
      if (opValue === undefined) continue;

      if (op === "in") {
        const list = opValue as unknown[];
        if (list.length === 0) {
          // `IN ()` is invalid SQL; short-circuit to a clause that matches nothing.
          conditions.push("FALSE");
          continue;
        }
        const placeholders = list.map(() => `$${paramIndex++}`).join(", ");
        conditions.push(`${column} IN (${placeholders})`);
        values.push(...list);
      } else if (op === "contains") {
        conditions.push(`${column} ILIKE $${paramIndex++}`);
        values.push(`%${opValue}%`);
      } else if (op === "startsWith") {
        conditions.push(`${column} ILIKE $${paramIndex++}`);
        values.push(`${opValue}%`);
      } else if (op === "endsWith") {
        conditions.push(`${column} ILIKE $${paramIndex++}`);
        values.push(`%${opValue}`);
      } else if (op in OPERATOR_SQL) {
        conditions.push(`${column} ${OPERATOR_SQL[op]} $${paramIndex++}`);
        values.push(opValue);
      } else {
        throw new Error(`Unknown where operator "${op}" on field "${field}"`);
      }
    }
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

export function compileOrderBy(orderBy: Record<string, "asc" | "desc"> | undefined): string {
  if (!orderBy || Object.keys(orderBy).length === 0) return "";
  const parts = Object.entries(orderBy).map(
    ([field, dir]) => `${quoteIdent(field)} ${dir === "desc" ? "DESC" : "ASC"}`,
  );
  return `ORDER BY ${parts.join(", ")}`;
}

export interface SelectQuery extends CompiledClause {}

export function buildSelectQuery(
  table: string,
  args: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; take?: number; skip?: number } = {},
): SelectQuery {
  const where = compileWhere(args.where, 1);
  const orderBy = compileOrderBy(args.orderBy);
  const values = [...where.values];

  let sql = `SELECT * FROM ${quoteIdent(table)}`;
  if (where.sql) sql += ` ${where.sql}`;
  if (orderBy) sql += ` ${orderBy}`;
  if (typeof args.take === "number") {
    values.push(args.take);
    sql += ` LIMIT $${values.length}`;
  }
  if (typeof args.skip === "number") {
    values.push(args.skip);
    sql += ` OFFSET $${values.length}`;
  }

  return { sql, values };
}

export function buildInsertQuery(table: string, data: Record<string, unknown>): CompiledClause {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    return { sql: `INSERT INTO ${quoteIdent(table)} DEFAULT VALUES RETURNING *`, values: [] };
  }
  const columns = keys.map(quoteIdent).join(", ");
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  const values = keys.map((k) => data[k]);
  return {
    sql: `INSERT INTO ${quoteIdent(table)} (${columns}) VALUES (${placeholders}) RETURNING *`,
    values,
  };
}

export function buildUpdateQuery(
  table: string,
  data: Record<string, unknown>,
  where: Record<string, unknown> | undefined,
): CompiledClause {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error("update() called with an empty data object");
  }
  const setClause = keys.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(", ");
  const values: unknown[] = keys.map((k) => data[k]);

  const compiledWhere = compileWhere(where, keys.length + 1);
  values.push(...compiledWhere.values);

  let sql = `UPDATE ${quoteIdent(table)} SET ${setClause}`;
  if (compiledWhere.sql) sql += ` ${compiledWhere.sql}`;
  sql += " RETURNING *";

  return { sql, values };
}

export function buildDeleteQuery(
  table: string,
  where: Record<string, unknown> | undefined,
): CompiledClause {
  const compiledWhere = compileWhere(where, 1);
  let sql = `DELETE FROM ${quoteIdent(table)}`;
  if (compiledWhere.sql) sql += ` ${compiledWhere.sql}`;
  sql += " RETURNING *";
  return { sql, values: compiledWhere.values };
}

export function buildCountQuery(
  table: string,
  where: Record<string, unknown> | undefined,
): CompiledClause {
  const compiledWhere = compileWhere(where, 1);
  let sql = `SELECT COUNT(*)::int AS count FROM ${quoteIdent(table)}`;
  if (compiledWhere.sql) sql += ` ${compiledWhere.sql}`;
  return { sql, values: compiledWhere.values };
}
