// Derives one MCP tool per collection operation and per action from an AppSchema (contract §7),
// and maps tool arguments to Data API queries (contract §5) and Data API results back to tool results.
import type { ActionDef, AppSchema, CollectionDef, FieldDef, QueryRequest, Where } from '@kelay/contracts';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type { DataResult } from './data-api.ts';

export type JsonSchema = Record<string, unknown>;
export type CollectionOp = 'list' | 'get' | 'create' | 'update' | 'delete';

export type ToolTarget =
  | { kind: 'collection'; op: CollectionOp; collection: CollectionDef }
  | { kind: 'action'; action: ActionDef };

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  target: ToolTarget;
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

/** "tickets" → "ticket", "categories" → "category", "statuses" → "status". */
export function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y';
  if (/(ss|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

const prose = (name: string): string => name.replaceAll('_', ' ');
const labelOf = (c: CollectionDef): string => c.label ?? prose(c.name).replace(/^\w/, (ch) => ch.toUpperCase());
export const nounOf = (c: CollectionDef): { one: string; many: string } => ({
  one: singular(prose(c.name)),
  many: prose(c.name),
});

const SCALAR: JsonSchema = { type: ['string', 'number', 'boolean', 'null'] };
const CONDITION: JsonSchema = {
  type: 'object',
  description: 'Comparison: eq, ne, in (list), gt, gte, lt, lte, or like (SQL LIKE pattern, % matches anything).',
  properties: {
    eq: SCALAR,
    ne: SCALAR,
    in: { type: 'array', items: SCALAR, maxItems: 500 },
    gt: SCALAR,
    gte: SCALAR,
    lt: SCALAR,
    lte: SCALAR,
    like: { type: 'string' },
  },
  additionalProperties: false,
  minProperties: 1,
};
const ID: JsonSchema = { type: 'string', format: 'uuid' };

function typeHint(f: FieldDef): string | undefined {
  switch (f.type) {
    case 'timestamp':
      return 'ISO 8601 date-time, e.g. 2026-11-11T09:00:00Z.';
    case 'ref':
      return f.ref ? `Id of a ${singular(prose(f.ref))}.` : 'Id of a related record.';
    case 'json':
      return 'Any JSON value.';
    default:
      return undefined;
  }
}

function fieldSchema(f: FieldDef, nullable: boolean): JsonSchema {
  const description = [f.description, typeHint(f)].filter(Boolean).join(' ');
  const withDescription = (s: JsonSchema): JsonSchema => (description ? { ...s, description } : s);
  const typed = (type: string, extra: JsonSchema = {}): JsonSchema =>
    withDescription({ type: nullable ? [type, 'null'] : type, ...extra });
  switch (f.type) {
    case 'text':
      return typed('string');
    case 'number':
      return typed('number');
    case 'boolean':
      return typed('boolean');
    case 'timestamp':
      return typed('string', { format: 'date-time' });
    case 'uuid':
    case 'ref':
      return typed('string', { format: 'uuid' });
    case 'json':
      return withDescription({});
  }
}

/** Fields a client may write. `owner_id` is set by its column default; `shared` exists only on shared collections. */
function writableFields(c: CollectionDef): Record<string, FieldDef> {
  const fields: Record<string, FieldDef> = { ...c.fields };
  if (c.shared) {
    fields.shared = {
      type: 'boolean',
      description: `When true, people in your organization who can see shared ${nounOf(c).many} can see this one.`,
    };
  }
  return fields;
}

/** "text, required: todo | doing | review | done" — a field's type, requiredness and description in one phrase. */
export function fieldAbout(f: FieldDef): string {
  const facts = [f.type === 'ref' && f.ref ? `id of a ${singular(prose(f.ref))}` : f.type, f.required ? 'required' : undefined];
  return [facts.filter(Boolean).join(', '), f.description].filter(Boolean).join(': ');
}

/** Every column `where` may filter on: the declared fields plus the implicit columns (contract §2). */
function filterColumns(c: CollectionDef): Record<string, string> {
  const columns: Record<string, string> = {
    id: 'uuid',
    org_id: 'text',
    owner_id: 'text, id of the user who created it',
    created_at: 'timestamp',
    updated_at: 'timestamp',
  };
  if (c.shared) columns.shared = 'boolean';
  for (const [name, f] of Object.entries(c.fields)) columns[name] = fieldAbout(f);
  return columns;
}

function objectSchema(fields: Record<string, FieldDef>, opts: { nullableOptional: boolean; requireDeclared: boolean }): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, f] of Object.entries(fields)) {
    properties[name] = fieldSchema(f, opts.nullableOptional && !f.required);
    if (opts.requireDeclared && f.required) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

function collectionTools(c: CollectionDef): ToolDef[] {
  const { one, many } = nounOf(c);
  const label = labelOf(c);
  const labelOne = singular(label);
  const columns = filterColumns(c);
  const columnList = Object.entries(columns)
    .map(([name, about]) => `${name} (${about})`)
    .join('; ');
  const target = (op: CollectionOp): ToolTarget => ({ kind: 'collection', op, collection: c });
  const writable = writableFields(c);
  return [
    {
      name: `${c.name}_list`,
      title: `List ${label}`,
      description: `List ${many} you can see, newest first. Filter with \`where\`; returns at most \`limit\` ${many}.`,
      inputSchema: {
        type: 'object',
        properties: {
          where: {
            type: 'object',
            description: `Filters, all of which must match. Map a column to a value for equality, or to a comparison object. Columns: ${columnList}.`,
            propertyNames: { enum: Object.keys(columns) },
            additionalProperties: { anyOf: [SCALAR, CONDITION] },
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LIST_LIMIT,
            default: DEFAULT_LIST_LIMIT,
            description: `Maximum number of ${many} to return.`,
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      target: target('list'),
    },
    {
      name: `${c.name}_get`,
      title: `Get ${labelOne}`,
      description: `Get one ${one} by id.`,
      inputSchema: { type: 'object', properties: { id: { ...ID, description: `Id of the ${one}.` } }, required: ['id'], additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      target: target('get'),
    },
    {
      name: `${c.name}_create`,
      title: `Create ${labelOne}`,
      description: `Create a ${one}. Returns the new ${one}, including its id.`,
      inputSchema: objectSchema(writable, { nullableOptional: true, requireDeclared: true }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      target: target('create'),
    },
    {
      name: `${c.name}_update`,
      title: `Update ${labelOne}`,
      description: `Change fields of a ${one}. Pass its id, and in \`values\` only the fields to change.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { ...ID, description: `Id of the ${one}.` },
          values: { ...objectSchema(writable, { nullableOptional: true, requireDeclared: false }), minProperties: 1 },
        },
        required: ['id', 'values'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      target: target('update'),
    },
    {
      name: `${c.name}_delete`,
      title: `Delete ${labelOne}`,
      description: `Delete a ${one} by id.`,
      inputSchema: { type: 'object', properties: { id: { ...ID, description: `Id of the ${one}.` } }, required: ['id'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      target: target('delete'),
    },
  ];
}

function actionTool(a: ActionDef): ToolDef {
  return {
    name: `action_${a.name}`,
    title: prose(a.name).replace(/^\w/, (ch) => ch.toUpperCase()),
    description: a.description,
    inputSchema: objectSchema(a.input, { nullableOptional: false, requireDeclared: true }),
    annotations: { readOnlyHint: false, openWorldHint: true },
    target: { kind: 'action', action: a },
  };
}

export function buildTools(schema: AppSchema): ToolDef[] {
  return [...schema.collections.flatMap(collectionTools), ...(schema.actions ?? []).map(actionTool)];
}

type Args = Record<string, unknown>;

export function toQuery(op: CollectionOp, collection: string, args: Args): QueryRequest {
  const byId: Where = { id: args.id as string };
  switch (op) {
    case 'list':
      return {
        op: 'select',
        collection,
        ...(args.where ? { where: args.where as Where } : {}),
        orderBy: [{ field: 'created_at', dir: 'desc' }],
        limit: (args.limit as number | undefined) ?? DEFAULT_LIST_LIMIT,
      };
    case 'get':
      return { op: 'select', collection, where: byId, limit: 1 };
    case 'create':
      return { op: 'insert', collection, values: args };
    case 'update':
      return { op: 'update', collection, where: byId, values: args.values as Args };
    case 'delete':
      return { op: 'delete', collection, where: byId };
  }
}

export const toolError = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

const toolJson = (value: Record<string, unknown>, text = JSON.stringify(value)): CallToolResult => ({
  content: [{ type: 'text', text }],
  structuredContent: value,
});

function deniedSentence(op: CollectionOp, c: CollectionDef): string {
  const { one, many } = nounOf(c);
  switch (op) {
    case 'list':
      return `You don't have permission to view ${many}.`;
    case 'get':
      return `You don't have permission to view this ${one}.`;
    case 'create':
      return `You don't have permission to create ${many}.`;
    case 'update':
      return `You don't have permission to update this ${one}.`;
    case 'delete':
      return `You don't have permission to delete this ${one}.`;
  }
}

/** Turns a Data API answer into a tool result. Failures stay tool results (isError) so the assistant can read them. */
export function present(op: CollectionOp, c: CollectionDef, args: Args, result: DataResult): CallToolResult {
  const { one } = nounOf(c);
  if (!result.ok) {
    switch (result.code) {
      case 'denied':
        return toolError(deniedSentence(op, c));
      case 'invalid_request':
      case 'unknown_collection':
        return toolError(`The request was rejected: ${result.message}`);
      case 'rate_limited':
        return toolError('Too many requests right now. Try again in a minute.');
      case 'unauthenticated':
        return toolError('Your sign-in for this app is no longer valid. Reconnect the assistant to continue.');
      default:
        return toolError('Something went wrong on Kelay while handling this request. Try again shortly.');
    }
  }
  const row = result.rows[0];
  switch (op) {
    case 'list':
      return toolJson({ rows: result.rows, count: result.count });
    case 'create':
      return row ? toolJson(row) : toolError(`The ${one} was not created.`);
    case 'get':
    case 'update':
      return row ? toolJson(row) : toolError(`No ${one} with id ${String(args.id)} is visible to you.`);
    case 'delete':
      return row ? toolJson(row, `Deleted ${one} ${String(args.id)}.`) : toolError(`No ${one} with id ${String(args.id)} is visible to you.`);
  }
}
