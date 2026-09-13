/**
 * The client is the only "magic" part of the ORM, and it's a small amount of
 * magic on purpose: given a map of models, it builds one repository per
 * model (`db.todo`, `db.user`, ...) with `create` / `findMany` / `findFirst`
 * / `update` / `delete` / `count`, all fully typed from the model's shape.
 *
 * Under the hood every repository method just calls into query-builder.ts to
 * produce a parameterized query, then runs it through `postgres` (the
 * lightweight driver used by Neon, Supabase, and most serverless Postgres
 * setups). There is no hidden ORM runtime, no proxy magic beyond object
 * construction, and no query it generates that you couldn't hand-write.
 */

import postgres from "postgres";
import type { Sql } from "postgres";
import type { ModelDef, ModelMap, InferRow, InferInsert, InferUpdate } from "./schema.js";
import {
  buildSelectQuery,
  buildInsertQuery,
  buildUpdateQuery,
  buildDeleteQuery,
  buildCountQuery,
  type FindManyArgs,
  type FindFirstArgs,
  type WhereInput,
} from "./query-builder.js";

export interface Repository<M extends ModelDef<any, any>> {
  create(data: InferInsert<M>): Promise<InferRow<M>>;
  findMany(args?: FindManyArgs<M>): Promise<InferRow<M>[]>;
  findFirst(args?: FindFirstArgs<M>): Promise<InferRow<M> | null>;
  update(args: { where: WhereInput<M>; data: InferUpdate<M> }): Promise<InferRow<M>[]>;
  delete(args: { where: WhereInput<M> }): Promise<InferRow<M>[]>;
  count(args?: { where?: WhereInput<M> }): Promise<number>;
}

export type Client<Models extends ModelMap> = {
  [K in keyof Models]: Repository<Models[K]>;
} & {
  /** Runs `fn` inside a single Postgres transaction; rolls back on throw. */
  $transaction<T>(fn: (tx: Client<Models>) => Promise<T>): Promise<T>;
  /** Closes the underlying connection pool. Call this on shutdown. */
  $disconnect(): Promise<void>;
  /** Escape hatch for raw SQL the typed API doesn't cover yet. */
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
};

export interface CreateClientOptions {
  /** A Postgres connection string, e.g. from Neon or Supabase. */
  connectionString: string;
  /** Forwarded to `postgres()` — useful for `ssl`, `max` pool size, etc. */
  ssl?: "require" | boolean;
  max?: number;
  /** Log every generated SQL statement + params. Off by default. */
  debug?: boolean;
}

function buildRepository<M extends ModelDef<any, any>>(
  sql: Sql,
  model: M,
  debug: boolean,
): Repository<M> {
  const table = model.name;

  const run = async (compiled: { sql: string; values: unknown[] }) => {
    if (debug) console.log(`[light-orm] ${compiled.sql}`, compiled.values);
    return sql.unsafe(compiled.sql, compiled.values as any[]);
  };

  return {
    async create(data) {
      const rows = await run(buildInsertQuery(table, data as Record<string, unknown>));
      return rows[0] as InferRow<M>;
    },
    async findMany(args = {}) {
      const rows = await run(buildSelectQuery(table, args as any));
      return rows as unknown as InferRow<M>[];
    },
    async findFirst(args = {}) {
      const rows = await run(buildSelectQuery(table, { ...(args as any), take: 1 }));
      return (rows[0] as InferRow<M>) ?? null;
    },
    async update({ where, data }) {
      const rows = await run(
        buildUpdateQuery(table, data as Record<string, unknown>, where as Record<string, unknown>),
      );
      return rows as unknown as InferRow<M>[];
    },
    async delete({ where }) {
      const rows = await run(buildDeleteQuery(table, where as Record<string, unknown>));
      return rows as unknown as InferRow<M>[];
    },
    async count(args = {}) {
      const rows = await run(buildCountQuery(table, args.where as Record<string, unknown>));
      return (rows[0] as unknown as { count: number }).count;
    },
  };
}

function buildClient<Models extends ModelMap>(
  sql: Sql,
  models: Models,
  debug: boolean,
): Client<Models> {
  const client = {} as Record<string, unknown>;

  for (const key of Object.keys(models)) {
    client[key] = buildRepository(sql, models[key]!, debug);
  }

  client.$transaction = <T>(fn: (tx: Client<Models>) => Promise<T>): Promise<T> => {
    return sql.begin(async (txSql) => {
      const txClient = buildClient(txSql as unknown as Sql, models, debug);
      return fn(txClient);
    }) as unknown as Promise<T>;
  };

  client.$disconnect = () => sql.end();

  client.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const pending = sql(strings as any, ...values) as unknown as Promise<unknown[]>;
    const rows = await pending;
    return rows;
  };

  return client as Client<Models>;
}

/**
 * Creates a typed client from a map of models.
 *
 * @example
 * const db = createClient({ todo: Todo }, {
 *   connectionString: process.env.DATABASE_URL!,
 * });
 * const open = await db.todo.findMany({ where: { completed: false } });
 */
export function createClient<Models extends ModelMap>(
  models: Models,
  options: CreateClientOptions,
): Client<Models> {
  const sql = postgres(options.connectionString, {
    ssl: options.ssl ?? "require",
    max: options.max ?? 10,
  });
  return buildClient(sql, models, options.debug ?? false);
}
