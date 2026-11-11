// Type-level view of an AppSchema: `Row<typeof app, 'tickets'>` and friends. These only infer
// literal types when the schema comes from defineApp (or `as const`).
import type { AppSchema, FieldType, GraphSpec, PolicyMatrix, Scalar } from '@kelay/contracts';

export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type AppSchemaInput = DeepReadonly<AppSchema>;
export type PolicyMatrixInput = DeepReadonly<PolicyMatrix>;
export type GraphSpecInput = DeepReadonly<GraphSpec>;

/** An app slug, or the value returned by defineApp (which also types collections and rows). */
export type AppRef = string | AppSchemaInput;

export type SchemaOf<A extends AppRef> = A extends AppSchemaInput ? A : AppSchemaInput;

export type CollectionName<A extends AppRef> = SchemaOf<A>['collections'][number]['name'];

export type CollectionOf<A extends AppRef, N extends string> = Extract<SchemaOf<A>['collections'][number], { readonly name: N }>;

interface FieldTypeMap {
  text: string;
  number: number;
  boolean: boolean;
  /** ISO 8601 string, as the Data API serializes timestamptz. */
  timestamp: string;
  uuid: string;
  ref: string;
  json: unknown;
}

export type FieldValue<F> = F extends { readonly type: infer T extends FieldType } ? FieldTypeMap[T] : unknown;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type FieldsOf<C> = C extends { readonly fields: infer F } ? F : never;
type RequiredKeys<F> = { [K in keyof F]-?: F[K] extends { readonly required: true } ? K : never }[keyof F];
type OptionalKeys<F> = Exclude<keyof F, RequiredKeys<F>>;
type FieldColumns<F> = { -readonly [K in RequiredKeys<F>]: FieldValue<F[K]> } & {
  -readonly [K in OptionalKeys<F>]?: FieldValue<F[K]> | null;
};

/** Columns every collection table has (contract §2). */
export interface ImplicitColumns {
  id: string;
  org_id: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

/** Row of an app referenced by slug only, where field types are unknown. */
export type AnyRow = ImplicitColumns & { [field: string]: unknown };

/** A row as the Data API returns it: implicit columns, `shared` when the collection has it, then the fields. */
export type Row<A extends AppRef, N extends CollectionName<A>> = string extends CollectionName<A>
  ? AnyRow
  : Simplify<
      ImplicitColumns &
        (CollectionOf<A, N> extends { readonly shared: true } ? { shared: boolean } : unknown) &
        FieldColumns<FieldsOf<CollectionOf<A, N>>>
    >;

/** Values for `create`: required fields must be present; implicit columns are set by the database. */
export type NewRow<A extends AppRef, N extends CollectionName<A>> = string extends CollectionName<A>
  ? { [field: string]: unknown }
  : Simplify<
      (CollectionOf<A, N> extends { readonly shared: true } ? { shared?: boolean } : unknown) &
        FieldColumns<FieldsOf<CollectionOf<A, N>>>
    >;

/** Values for `update`. */
export type RowPatch<A extends AppRef, N extends CollectionName<A>> = Partial<NewRow<A, N>>;

type WhereValue<V> = unknown extends V ? Scalar : Exclude<V, undefined>;

export type Condition<V> =
  | V
  | null
  | { eq?: V | null; ne?: V | null; in?: readonly (V | null)[]; gt?: V; gte?: V; lt?: V; lte?: V; like?: string };

/** Equality by default, or an operator object (contract §5). */
export type WhereFor<R> = { [K in keyof R & string]?: Condition<WhereValue<R[K]>> };

export interface OrderTerm<R> {
  field: keyof R & string;
  dir?: 'asc' | 'desc';
}

export interface ListQuery<R> {
  where?: WhereFor<R>;
  orderBy?: readonly OrderTerm<R>[];
  limit?: number;
  offset?: number;
}
