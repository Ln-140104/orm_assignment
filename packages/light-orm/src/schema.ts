/**
 * Schema definition layer.
 *
 * A "column" is a small, serializable description of one field: its runtime
 * JS type, whether it's nullable, whether it has a default, and whether it's
 * the primary key. Everything else in the ORM (query typing, insert typing,
 * SQL generation) is *derived* from this description via TypeScript generics
 * — there is exactly one source of truth per model.
 */

export type ColumnType = "number" | "string" | "boolean" | "date" | "json";

/** Maps a ColumnType to the TS type it represents at runtime. */
type JsTypeOf<T extends ColumnType> = T extends "number"
  ? number
  : T extends "string"
    ? string
    : T extends "boolean"
      ? boolean
      : T extends "date"
        ? Date
        : T extends "json"
          ? unknown
          : never;

export interface ColumnDef<
  T extends ColumnType = ColumnType,
  TJs = JsTypeOf<T>,
  TOptional extends boolean = boolean,
  THasDefault extends boolean = boolean,
  TPrimaryKey extends boolean = boolean,
> {
  readonly kind: "column";
  readonly type: T;
  readonly optional: TOptional;
  readonly hasDefault: THasDefault;
  readonly defaultValue: TJs | undefined;
  readonly isPrimaryKey: TPrimaryKey;
  readonly isUnique: boolean;
  /** Phantom field only — never set at runtime, used purely for inference. */
  readonly __t?: TJs;
}

interface RawColumnOptions<TJs, TOptional extends boolean, TDefault extends TJs | undefined, TPK extends boolean> {
  optional?: TOptional;
  default?: TDefault;
  primaryKey?: TPK;
  unique?: boolean;
}

/**
 * Builds a column def. The three "flag" generics (`TOptional`, `TDefault`,
 * `TPK`) are deliberately inferred from the *literal* options object passed
 * at the call site (e.g. `{ optional: true }` infers `TOptional = true`, not
 * the widened `boolean`) — that's what lets `InferInsert` below correctly
 * compute which fields are required vs. optional per model.
 */
function column<
  T extends ColumnType,
  TJs,
  TOptional extends boolean = false,
  TDefault extends TJs | undefined = undefined,
  TPK extends boolean = false,
>(
  type: T,
  opts?: RawColumnOptions<TJs, TOptional, TDefault, TPK>,
): ColumnDef<T, TJs, TOptional, [TDefault] extends [undefined] ? false : true, TPK> {
  return {
    kind: "column",
    type,
    optional: (opts?.optional ?? false) as TOptional,
    hasDefault: (opts?.default !== undefined) as [TDefault] extends [undefined] ? false : true,
    defaultValue: opts?.default,
    isPrimaryKey: (opts?.primaryKey ?? false) as TPK,
    isUnique: opts?.unique ?? false,
  };
}

/** A required or optional numeric column (maps to `double precision`). */
export function number<
  TOptional extends boolean = false,
  TDefault extends number | undefined = undefined,
  TPK extends boolean = false,
>(opts?: RawColumnOptions<number, TOptional, TDefault, TPK>) {
  return column<"number", number, TOptional, TDefault, TPK>("number", opts);
}

/** A required or optional text column (maps to `text`). */
export function string<
  TOptional extends boolean = false,
  TDefault extends string | undefined = undefined,
  TPK extends boolean = false,
>(opts?: RawColumnOptions<string, TOptional, TDefault, TPK>) {
  return column<"string", string, TOptional, TDefault, TPK>("string", opts);
}

/** A required or optional boolean column (maps to `boolean`). */
export function boolean<
  TOptional extends boolean = false,
  TDefault extends boolean | undefined = undefined,
  TPK extends boolean = false,
>(opts?: RawColumnOptions<boolean, TOptional, TDefault, TPK>) {
  return column<"boolean", boolean, TOptional, TDefault, TPK>("boolean", opts);
}

/** A required or optional timestamp column (maps to `timestamptz`). */
export function date<
  TOptional extends boolean = false,
  TDefault extends Date | undefined = undefined,
  TPK extends boolean = false,
>(opts?: RawColumnOptions<Date, TOptional, TDefault, TPK>) {
  return column<"date", Date, TOptional, TDefault, TPK>("date", opts);
}

/** A required or optional JSON column (maps to `jsonb`). */
export function json<
  TOptional extends boolean = false,
  TDefault extends unknown | undefined = undefined,
  TPK extends boolean = false,
>(opts?: RawColumnOptions<unknown, TOptional, TDefault, TPK>) {
  return column<"json", unknown, TOptional, TDefault, TPK>("json", opts);
}

/**
 * Convenience helper for auto-incrementing primary keys — the overwhelmingly
 * common case (`id: id()`). Equivalent to `number({ primaryKey: true })`.
 */
export function id() {
  return number({ primaryKey: true });
}

export type Shape = Record<string, ColumnDef<any, any, any, any, any>>;

export interface ModelDef<
  TName extends string = string,
  TShape extends Shape = Shape,
> {
  readonly kind: "model";
  readonly name: TName;
  readonly shape: TShape;
}

/**
 * Defines a model (maps 1:1 to a Postgres table). The returned object carries
 * both the runtime shape (used to build SQL) and, via generics, the static
 * type information every downstream API (client, query builder) relies on.
 *
 * @example
 * const Todo = defineModel("todo", {
 *   id: id(),
 *   title: string(),
 *   completed: boolean({ default: false }),
 *   createdAt: date({ default: new Date() }),
 * });
 */
export function defineModel<TName extends string, TShape extends Shape>(
  name: TName,
  shape: TShape,
): ModelDef<TName, TShape> {
  return { kind: "model", name, shape };
}

// ---------------------------------------------------------------------------
// Type inference: everything below derives static types from a ModelDef.
// This is what makes `db.todo.findMany(...)` fully typed with zero manual
// interfaces — the developer only ever writes the schema once.
// ---------------------------------------------------------------------------

type ColumnJsType<C> = C extends ColumnDef<any, infer TJs> ? TJs : never;

/** The full "row" shape returned by SELECT — every column, honoring `optional`. */
export type InferRow<M extends ModelDef<any, any>> = {
  [K in keyof M["shape"]]: M["shape"][K]["optional"] extends true
    ? ColumnJsType<M["shape"][K]> | null
    : ColumnJsType<M["shape"][K]>;
};

type RequiredInsertKeys<S extends Shape> = {
  [K in keyof S]: S[K]["optional"] extends true
    ? never
    : S[K]["hasDefault"] extends true
      ? never
      : S[K]["isPrimaryKey"] extends true
        ? never
        : K;
}[keyof S];

type OptionalInsertKeys<S extends Shape> = Exclude<keyof S, RequiredInsertKeys<S>>;

/**
 * The shape accepted by `.create(...)`: fields that are optional, have a
 * default, or are the primary key (auto-generated by Postgres) become
 * optional on insert. Everything else is required — so forgetting a required
 * field is a compile-time error, not a runtime surprise.
 */
export type InferInsert<M extends ModelDef<any, any>> = {
  [K in RequiredInsertKeys<M["shape"]>]: ColumnJsType<M["shape"][K]>;
} & {
  [K in OptionalInsertKeys<M["shape"]>]?: ColumnJsType<M["shape"][K]>;
};

/** The shape accepted by `.update(...)`: every field is optional. */
export type InferUpdate<M extends ModelDef<any, any>> = Partial<{
  [K in keyof M["shape"]]: ColumnJsType<M["shape"][K]>;
}>;

export type ModelMap = Record<string, ModelDef<any, any>>;
