# @lakku/light-orm

A tiny, type-safe TypeScript ORM built for serverless Postgres (Neon,
Supabase, or any Postgres-compatible database).

```bash
npm install @lakku/light-orm
```

## Quick start

```ts
import { createClient, defineModel, id, string, boolean, date } from "@lakku/light-orm";

const Todo = defineModel("todo", {
  id: id(),
  title: string(),
  completed: boolean({ default: false }),
  createdAt: date({ default: new Date() }),
});

const db = createClient(
  { todo: Todo },
  { connectionString: process.env.DATABASE_URL! },
);

// Create the table (idempotent — safe to call on every boot in dev).
import { migrate } from "@lakku/light-orm";
await migrate(process.env.DATABASE_URL!, { todo: Todo });

// Fully typed CRUD:
const created = await db.todo.create({ title: "Write documentation" });
const open = await db.todo.findMany({ where: { completed: false } });
await db.todo.update({ where: { id: created.id }, data: { completed: true } });
await db.todo.delete({ where: { id: created.id } });

// Transactions:
await db.$transaction(async (tx) => {
  await tx.todo.create({ title: "Step 1" });
  await tx.todo.create({ title: "Step 2" });
});
```

## API

### Columns

`number()`, `string()`, `boolean()`, `date()`, `json()` — each accepts
`{ optional?, default?, primaryKey?, unique? }`. `id()` is shorthand for
`number({ primaryKey: true })`.

### `defineModel(name, shape)`

Declares a model. `name` becomes the Postgres table name.

### `createClient(models, options)`

`options.connectionString` (required), `options.ssl` (`"require" | boolean`,
default `"require"`), `options.max` (pool size, default `10`),
`options.debug` (logs generated SQL, default `false`).

Returns one repository per model key, each with:
- `create(data)`
- `findMany({ where?, orderBy?, take?, skip? })`
- `findFirst({ where?, orderBy? })`
- `update({ where, data })`
- `delete({ where })`
- `count({ where? })`

Plus `$transaction(fn)`, `$disconnect()`, and `$queryRaw` for raw SQL.

### `where` operators

```ts
{ completed: false }                          // shorthand for equals
{ title: { contains: "assignment" } }          // ILIKE '%assignment%'
{ title: { startsWith: "Finish" } }
{ id: { in: [1, 2, 3] } }
{ id: { gt: 5, lte: 20 } }
```

### `migrate(connectionString, models)` / `generateSchemaSQL(models)`

Generates and (optionally) runs `CREATE TABLE IF NOT EXISTS` for every model.
Not a full migration system — see the repo root `README.md` "Limitations".

## License

MIT
