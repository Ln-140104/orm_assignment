# light-orm

A small, type-safe TypeScript ORM for serverless Postgres (Neon, Supabase, or
any Postgres-compatible database), plus a Todo app that consumes it as a
regular npm dependency.

```ts
const Todo = defineModel("todo", {
  id: id(),
  title: string(),
  completed: boolean({ default: false }),
});

const db = createClient({ todo: Todo }, { connectionString: process.env.DATABASE_URL! });

const open = await db.todo.findMany({ where: { completed: false } });
//    ^? { id: number; title: string; completed: boolean; createdAt: Date }[]
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the type system and query
builder are designed, and [`packages/light-orm/README.md`](./packages/light-orm/README.md)
for the package's own API reference.

---

## Repo layout

```
orm-assignment/
├── packages/
│   └── light-orm/       the ORM package (publishable to npm)
└── apps/
    └── todo-app/        example app consuming @lakku/light-orm
```

## Setup

Requires Node 18+ and a Postgres database (local, Neon, or Supabase).

```bash
npm install                        # installs all workspaces
npm run build                      # builds the ORM, then the Todo app
```

### Database configuration

1. Copy the env template:
   ```bash
   cp apps/todo-app/.env.example apps/todo-app/.env
   ```
2. Set `DATABASE_URL` to your Postgres connection string.
   - **Neon**: `postgres://user:password@ep-xxxx.us-east-2.aws.neon.tech/dbname?sslmode=require`
   - **Supabase**: from Project Settings → Database → Connection string (URI mode)
   - **Local Postgres**: `postgres://postgres:postgres@localhost:5432/orm_test`, and set `DATABASE_SSL=false` (Neon/Supabase always need SSL; local Postgres usually doesn't)
3. Create the schema (this uses the ORM's own migration generator — see "Known limitations"):
   ```bash
   npm run db:migrate --workspace=apps/todo-app
   ```

### Running the Todo app

```bash
npm run build --workspace=apps/todo-app
npm run start --workspace=apps/todo-app
# or, for a watch-mode dev loop:
npm run dev --workspace=apps/todo-app
```

Then open **http://localhost:3000**. The frontend is a single static page
(vanilla HTML/CSS/JS, no build step) served by the same Express process that
exposes the JSON API under `/api`.

**Live demo:**(https://orm-assignment.onrender.com/)

### API reference (todo-app)

| Method | Path                        | Body                              |
|--------|-----------------------------|------------------------------------|
| GET    | `/api/todos?completed=bool` | –                                   |
| POST   | `/api/todos`                | `{ title: string }`                 |
| PATCH  | `/api/todos/:id`            | `{ completed?: bool, title?: string }` |
| DELETE | `/api/todos/:id`            | –                                   |
| GET    | `/api/todos/stats`          | –                                   |

---

## ORM design

**How models are defined.** A model is a name plus a map of columns
(`number()`, `string()`, `boolean()`, `date()`, `json()`, or the `id()`
shorthand for an auto-increment primary key). `defineModel` doesn't do
anything clever at runtime — it just returns `{ name, shape }` — all the
interesting behavior is in how TypeScript infers types *from* that shape (see
`ARCHITECTURE.md`).

**How queries are executed.** `createClient({ todo: Todo }, options)` builds
one repository per model. Each repository method (`create`, `findMany`,
`findFirst`, `update`, `delete`, `count`) is a thin function that:

1. Takes a typed argument (`where`, `data`, `orderBy`, ...).
2. Passes it to a pure function in `query-builder.ts` that compiles it into
   `{ sql: string, values: unknown[] }` — a parameterized query, never a
   string-interpolated one.
3. Executes that via [`postgres`](https://github.com/porsager/postgres), the
   lightweight driver most serverless Postgres providers recommend, and maps
   the rows straight back to the typed row shape.

Query flow, end to end:

```
Model API (db.todo.findMany)
        │
        ▼
Typed args (WhereInput, OrderByInput, ...)
        │
        ▼
query-builder.ts — compiles to parameterized SQL + values[]
        │
        ▼
postgres driver — sql.unsafe(text, values)
        │
        ▼
Postgres (Neon / Supabase / local)
        │
        ▼
Rows mapped back to InferRow<Model>
```

## TypeScript design

- **Column flags stay literal, not widened.** `number({ optional: true })`
  needs TypeScript to see `optional: true` (the literal), not `optional:
  boolean`. This is done by making `optional`/`hasDefault`/`primaryKey`
  generic parameters on `ColumnDef` itself, inferred from the options object
  at the call site, rather than plain `boolean` fields on an interface.
  Getting this right is what makes `InferInsert` — the type used by
  `.create(...)` — correctly mark auto-generated and defaulted columns as
  optional while keeping everything else required.
- **One schema, many derived types.** `InferRow`, `InferInsert`, and
  `InferUpdate` are all mapped types computed from a single `ModelDef`. There
  is no second place where field types are declared, so the schema can't
  drift out of sync with the types the client exposes.
- **Where clauses are narrowed per field type.** `WhereInput` picks the
  operator set (`gt`/`lt`/`in` for numbers, `contains`/`startsWith` for
  strings, `equals`/`not` for booleans) based on each field's own inferred
  type, so `db.todo.findMany({ where: { title: { gt: 5 } } })` is a compile
  error — that operator only exists for numeric fields.
- **Tradeoffs.** The type system does not (yet) validate relationships
  between models, nested/`OR`/`AND` where clauses, or column-level string
  literal unions (e.g. an enum-like `status` column) — see "Limitations"
  below.

## Limitations

- **No relations.** No foreign keys, `include`, or joins. Each model maps to
  exactly one table with no cross-model queries.
- **Limited operators.** `where` supports equality, comparison, `in`, and
  basic string matching — no `OR`, no nested/grouped conditions, no
  full-text search.
- **Migrations are additive only.** `generateSchemaSQL` emits `CREATE TABLE
  IF NOT EXISTS` from the current schema. It does not diff against an
  existing table, so renaming or removing a column requires a manual `ALTER
  TABLE` — there's no migration history or rollback.
- **`number` maps to `double precision`**, not a distinct `integer` type, so
  the ORM can't tell an int column from a float column at the SQL level.
- **No connection-level query caching, prepared statement reuse tuning, or
  read replicas awareness** — `postgres`'s defaults are used as-is.
- **No runtime validation layer** (e.g. rejecting a string over some length)
  beyond what Postgres itself enforces — TypeScript only catches
  compile-time misuse, not bad data arriving from `req.body`. The Todo app's
  routes do their own minimal request-shape validation for this reason.

## What I'd add next

Roughly in priority order: nested `AND`/`OR` where groups, a real migration
system (diffing against `information_schema` and generating `ALTER TABLE`),
relation support (`belongsTo`/`hasMany` with typed `include`), a fluent
query-builder alternative to the options-object API (`db.todo.query()
.where(...).orderBy(...).exec()`) for people who prefer chaining, and a thin
Zod-based validation layer that can piggyback on the same column
definitions.

## AI tool disclosure

I used Claude (Anthropic) as a pair-programming assistant throughout this assignment, primarily for:

Scaffolding the monorepo structure — workspace configuration, tsconfig setup, and the initial package.json files for both packages/light-orm and apps/todo-app.
Designing and implementing the type-inference layer in schema.ts — in particular, working out how to keep column flags (optional, hasDefault, primaryKey) as literal types rather than widened boolean, which is what makes InferInsert correctly compute required vs. optional fields per model. This was iterated on: an early version compiled but silently produced the wrong types (every field looked required), caught by writing @ts-expect-error sanity checks against the client and fixing the generics until those checks actually passed.
Writing the query builder and SQL generation (query-builder.ts, migrate.ts) — parameterized query construction, the where operator set, and the schema-to-DDL generator.
Debugging real, live issues during setup and deployment — an npm registry 2FA/publish-access error, an npm-workspaces build-ordering issue on Render (local workspace packages take precedence over published registry versions, so the ORM's dist/ had to be built before the Todo app's), and a git repository-root mixup during the initial push.
Writing the frontend (public/index.html, style.css, app.js) and the Express routes in apps/todo-app.
Drafting this README and ARCHITECTURE.md, including the query-flow diagram and the "what I'd add next" section.

What I did myself: reviewed every generated file, ran the build/typecheck/ migration/API tests personally against a live Postgres instance to confirm each piece actually worked (not just that it compiled), made the actual npm-publish and Render-deployment decisions and account setup, and pushed to GitHub. I can walk through the type system, the query flow, and the transaction implementation in detail, and can add a new model live.

## Time spent

2 Days
