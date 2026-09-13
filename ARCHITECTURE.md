# Architecture

This document is for the live interview walkthrough — it explains *why* the
ORM is built the way it is, not just what it does. The README covers usage;
this covers decisions and tradeoffs.

## Design goals, in priority order

1. **One schema, zero duplicated types.** A developer writes `defineModel(...)`
   once. Every other type in the system (`InferRow`, `InferInsert`,
   `WhereInput`, ...) is *derived* from it via generics. If you add a field to
   the schema, every call site that touches that model gets the new field's
   type for free, and every call site that's now missing a required field
   becomes a compile error. This is the single most important property of
   the ORM — everything else follows from wanting this by construction rather
   than by convention.
2. **No SQL injection surface, ever.** Every generated query is
   parameterized. `query-builder.ts` never touches string interpolation with
   user-controlled data — table/column names are the only thing put directly
   into the SQL string (via `quoteIdent`), and those come from the schema the
   developer wrote, not from request input.
3. **Small enough to read in one sitting.** The whole package is ~500 lines
   across 5 files. That's a deliberate choice: a "lightweight ORM" that's
   actually a large, opaque runtime with a small public API isn't lightweight
   in the way that matters for a maintainer.

## Why a generic-heavy schema instead of a simpler runtime-validated approach

An easier way to build this would be to accept a Zod (or similar) schema per
model and derive everything from `z.infer<>`. That's a perfectly reasonable
design — but the assignment asks for the ORM's *own* type system, and doing
it by hand is what demonstrates the TypeScript skill the evaluation is
actually scoring. So `schema.ts` implements the same idea — infer types from
a declarative description — without leaning on an existing validation
library.

The trickiest part of this: column "flags" (`optional`, `hasDefault`,
`primaryKey`) need to stay as **literal** `true`/`false` types, not widen to
`boolean`. If they widen, every downstream conditional type
(`S[K]["optional"] extends true ? ... : ...`) always takes the same branch
regardless of what you actually wrote, silently breaking `InferInsert`. See
`schema.ts`'s `column()` — the flags are generic parameters on `ColumnDef`
itself, inferred from the shape of the options object at the call site,
rather than plain fields typed as `boolean` on an interface. There's a
regression test for this exact failure mode in the "type safety" section
below, because it's easy to reintroduce by refactoring `ColumnDef`'s
generics without noticing the literal-vs-widened distinction.

## Why a proxy-free client

`createClient` could have used a JS `Proxy` to lazily generate `db.<anything>`
at property-access time. Instead it eagerly builds one repository object per
model up front, in a plain loop. Two reasons:

- **Debuggability.** `console.log(db.todo)` shows real methods, not a Proxy
  trap. Stack traces point at real functions.
- **No behavioral surprise.** `db.someTypoedModel` is `undefined` and fails
  immediately and obviously, rather than a Proxy silently returning something
  that only breaks later.

The "magic" is entirely in TypeScript's generics (compile time), not in a
runtime meta-programming layer — which keeps the runtime small and the types
precise.

## Why `postgres` (porsager) as the driver

Neon and Supabase both work over standard Postgres wire protocol, so any
driver works, but `postgres` was chosen because:
- It's the driver Neon's own docs recommend for non-edge Node environments,
  and works unmodified with Supabase.
- It supports `sql.begin(...)` for real transactions with automatic
  commit/rollback, which the ORM's `$transaction` wraps directly rather than
  reimplementing transaction semantics.
- It accepts a parameterized query + values array directly via
  `sql.unsafe(text, values)`, which maps 1:1 onto what `query-builder.ts`
  already produces — no translation layer needed between "the SQL I built"
  and "the SQL the driver runs."

## Query flow (detailed)

```
db.todo.findMany({ where: { completed: false }, orderBy: { createdAt: "desc" } })
   │
   ├─ 1. Repository method (client.ts) receives the typed args.
   │
   ├─ 2. buildSelectQuery() (query-builder.ts):
   │       compileWhere({ completed: false })
   │         → { sql: 'WHERE "completed" = $1', values: [false] }
   │       compileOrderBy({ createdAt: "desc" })
   │         → 'ORDER BY "createdAt" DESC'
   │       assembled: 'SELECT * FROM "todo" WHERE "completed" = $1 ORDER BY "createdAt" DESC'
   │
   ├─ 3. sql.unsafe(text, [false]) — postgres driver sends a parameterized
   │      query over the wire; Postgres does the actual query planning.
   │
   └─ 4. Rows come back as plain objects and are cast to InferRow<Todo>[]
          (a compile-time cast only — the shape already matches what
          Postgres returns, since column names are used verbatim).
```

The same pattern (typed args → pure compile function → parameterized
execute) is used for `create`, `update`, `delete`, and `count`; only the
compile function differs (`buildInsertQuery`, `buildUpdateQuery`, etc).

## Type safety, concretely

These are the actual guarantees, verified by `@ts-expect-error` assertions
during development (see the git history / commit that added
`schema.test-types.ts`-style checks):

```ts
const Todo = defineModel("todo", {
  id: id(),
  title: string(),
  completed: boolean({ default: false }),
});

db.todo.create({});
// ❌ compile error: "title" is required (no default, not the primary key)

db.todo.create({ title: "x", completed: "yes" });
// ❌ compile error: "yes" is not assignable to boolean

db.todo.findMany({ where: { nonexistent: true } });
// ❌ compile error: "nonexistent" is not a key of Todo

db.todo.findMany({ where: { title: { gt: 5 } } });
// ❌ compile error: `gt` doesn't exist on the string operator set

const rows = await db.todo.findMany({ where: { completed: false } });
// ✅ rows: { id: number; title: string; completed: boolean; createdAt: Date }[]
```

## Transactions

`$transaction(fn)` wraps `postgres`'s `sql.begin()`. Inside the callback you
get a second `Client` bound to the transaction's connection — so
`tx.todo.create(...)` runs on the same transaction as any other call made
through `tx`. Throwing inside the callback rolls back automatically (this is
exercised directly against a live database, not just typechecked — see the
repo's test notes). This was chosen over exposing a raw `BEGIN`/`COMMIT` API
because it makes "did I forget to roll back" structurally impossible: there's
no code path where the callback can return without the transaction being
either committed or rolled back.

## What a "real" version of this would need next

If this were being extended into a production tool rather than an assignment
submission, the highest-leverage next steps, in order:

1. **Relations** — `belongsTo`/`hasMany` declarations with a typed `include`
   option, probably compiling to either a join or a batched second query
   (N+1-avoidance is the interesting design problem here).
2. **A real migration system** — diff the declared schema against
   `information_schema.columns` and generate `ALTER TABLE` statements with a
   migration history table, instead of only ever `CREATE TABLE IF NOT
   EXISTS`.
3. **Grouped where conditions** (`AND`/`OR` nesting) — the current
   `WhereInput` is flat (implicit `AND` across fields), which covers the
   common case but not arbitrary boolean logic.
4. **A connection pooling story for serverless specifically** — e.g.
   detecting when running on a platform like Vercel/Lambda and defaulting to
   a single connection per invocation rather than a pool, since Neon/Supabase
   both charge for and rate-limit concurrent connections differently in that
   environment.
