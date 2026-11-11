// Compiles a QueryRequest (contract §5) into parameterized SQL for one collection table.
// Every identifier is checked against the collection's columns before Kysely sees it; Kysely
// quotes identifiers and binds every value as a parameter.
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
  type Expression,
  type ExpressionBuilder,
  type SqlBool,
} from 'kysely';
import { APP_DB_SCHEMA, RESERVED_COLUMNS, type CollectionDef, type FieldType, type QueryRequest, type Where } from '@kelay/contracts';
import { invalid } from './errors.ts';

/** Applied when a select has no `limit`; equal to the largest limit QueryRequest accepts. */
export const DEFAULT_SELECT_LIMIT = 500;

export type Row = Record<string, unknown>;

export interface QueryPlan {
  query: CompiledQuery<Row>;
  /** Update and delete only: whether the same `where` matches any row the caller can read. */
  probe?: CompiledQuery<Row>;
}

type Kind = Exclude<FieldType, 'ref'>;
type Param = string | number | boolean | null;
type Operator = 'eq' | 'ne' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'like';

interface Column {
  name: string;
  kind: Kind;
  writable: boolean;
}

const EXPECTS: Record<Kind, string> = {
  text: 'a string',
  number: 'a finite number',
  boolean: 'a boolean',
  timestamp: 'an ISO 8601 timestamp string',
  uuid: 'a uuid string',
  json: 'any JSON value',
};

const RANGE = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

const builder = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
}).withSchema(APP_DB_SCHEMA);

const reserved: ReadonlySet<string> = new Set(RESERVED_COLUMNS);
const columnCache = new WeakMap<CollectionDef, Map<string, Column>>();

function columnsOf(collection: CollectionDef): Map<string, Column> {
  const cached = columnCache.get(collection);
  if (cached) return cached;
  const cols = new Map<string, Column>();
  const add = (name: string, kind: Kind, writable: boolean) => cols.set(name, { name, kind, writable });
  add('id', 'uuid', false);
  add('org_id', 'text', false);
  add('owner_id', 'text', false);
  add('created_at', 'timestamp', false);
  add('updated_at', 'timestamp', false);
  if (collection.shared) add('shared', 'boolean', true);
  for (const [name, field] of Object.entries(collection.fields)) {
    if (!reserved.has(name)) add(name, field.type === 'ref' ? 'uuid' : field.type, true);
  }
  columnCache.set(collection, cols);
  return cols;
}

function column(cols: Map<string, Column>, name: string, place: string): Column {
  const col = cols.get(name);
  if (!col) throw invalid(`unknown field "${name}" in ${place}`);
  return col;
}

function writableColumn(cols: Map<string, Column>, name: string): Column {
  const col = column(cols, name, 'values');
  if (!col.writable) throw invalid(`field "${name}" is set by Kelay and cannot be written`);
  return col;
}

function encode(col: Column, value: unknown): Param {
  if (value === null) return null;
  // pg would send a JS array as a Postgres array literal, so JSON goes over the wire as text.
  if (col.kind === 'json') return JSON.stringify(value);
  const ok =
    col.kind === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : col.kind === 'boolean'
        ? typeof value === 'boolean'
        : typeof value === 'string';
  if (!ok) throw invalid(`field "${col.name}" expects ${EXPECTS[col.kind]}`);
  return value as Param;
}

function encodeRow(cols: Map<string, Column>, values: Record<string, unknown>): Record<string, Param> {
  return Object.fromEntries(Object.entries(values).map(([name, v]) => [name, encode(writableColumn(cols, name), v)]));
}

function condition(eb: ExpressionBuilder<any, any>, col: Column, op: Operator, value: unknown): Expression<SqlBool> {
  const ref = eb.ref(col.name);
  switch (op) {
    case 'eq':
      return value === null ? eb(ref, 'is', null) : eb(ref, '=', encode(col, value));
    case 'ne':
      return value === null ? eb(ref, 'is not', null) : eb(ref, 'is distinct from', encode(col, value));
    case 'in': {
      if (col.kind === 'json') throw invalid(`"in" does not apply to JSON field "${col.name}"`);
      const list = value as Param[];
      const values = list.filter((v) => v !== null).map((v) => encode(col, v));
      const terms: Expression<SqlBool>[] = [];
      if (values.length > 0) terms.push(eb(ref, 'in', values));
      if (values.length < list.length) terms.push(eb(ref, 'is', null));
      return terms.length > 0 ? eb.or(terms) : eb.lit(false);
    }
    case 'like':
      if (col.kind !== 'text') throw invalid(`"like" needs a text field; "${col.name}" is ${col.kind}`);
      return eb(ref, 'like', value as string);
    default:
      if (col.kind === 'json' || col.kind === 'boolean') throw invalid(`"${op}" does not apply to ${col.kind} field "${col.name}"`);
      if (value === null) throw invalid(`"${op}" cannot compare "${col.name}" with null`);
      return eb(ref, RANGE[op], encode(col, value));
  }
}

function whereClause(cols: Map<string, Column>, where: Where) {
  return (eb: ExpressionBuilder<any, any>) =>
    eb.and(
      Object.entries(where).flatMap(([name, cond]) => {
        const col = column(cols, name, 'where');
        if (cond === null || typeof cond !== 'object') return [condition(eb, col, 'eq', cond)];
        return Object.entries(cond).map(([op, v]) => condition(eb, col, op as Operator, v));
      }),
    );
}

function requireWhere(where: Where, op: string): void {
  if (Object.keys(where).length === 0) throw invalid(`${op} needs a non-empty where`);
}

function probe(collection: string, cols: Map<string, Column>, where: Where): CompiledQuery<Row> {
  return builder
    .selectFrom(collection)
    .select(sql.lit(1).as('one'))
    .where(whereClause(cols, where))
    .limit(1)
    .compile();
}

/** Throws `invalid_request` ApiErrors for anything the collection does not declare. */
export function planQuery(collection: CollectionDef, req: QueryRequest): QueryPlan {
  if (req.collection !== collection.name) throw new Error('planQuery: request is for another collection');
  const cols = columnsOf(collection);
  const table = collection.name;
  switch (req.op) {
    case 'select': {
      let q = builder.selectFrom(table).selectAll();
      if (req.where && Object.keys(req.where).length > 0) q = q.where(whereClause(cols, req.where));
      for (const o of req.orderBy ?? []) q = q.orderBy(column(cols, o.field, 'orderBy').name, o.dir ?? 'asc');
      q = q.limit(req.limit ?? DEFAULT_SELECT_LIMIT);
      if (req.offset) q = q.offset(req.offset);
      return { query: q.compile() };
    }
    case 'insert': {
      const rows = (Array.isArray(req.values) ? req.values : [req.values]).map((r) => encodeRow(cols, r));
      const anyColumn = rows.some((r) => Object.keys(r).length > 0);
      // Kysely fills columns a row omits with DEFAULT; rows with no columns at all need one named.
      const values = anyColumn ? rows : rows.map(() => ({ id: sql`default` }));
      return { query: builder.insertInto(table).values(values).returningAll().compile() };
    }
    case 'update': {
      const set = encodeRow(cols, req.values);
      if (Object.keys(set).length === 0) throw invalid('update needs at least one value');
      requireWhere(req.where, 'update');
      const query = builder
        .updateTable(table)
        .set({ ...set, updated_at: sql`now()` })
        .where(whereClause(cols, req.where))
        .returningAll()
        .compile();
      return { query, probe: probe(table, cols, req.where) };
    }
    case 'delete': {
      requireWhere(req.where, 'delete');
      const query = builder.deleteFrom(table).where(whereClause(cols, req.where)).returningAll().compile();
      return { query, probe: probe(table, cols, req.where) };
    }
  }
}
