// Data API client (contract §5): POST {dataApiUrl}/v1/apps/:app/query with the user's token.
import { QueryRequest, SLUG, type QueryResponse } from '@kelay/contracts';
import { z } from 'zod';
import { KelayError } from './errors.ts';
import { joinUrl, postJson, type AuthOptions } from './http.ts';
import type { AppRef, CollectionName, ListQuery, NewRow, Row, RowPatch } from './types.ts';

export interface KelayClientOptions<A extends AppRef> extends AuthOptions {
  dataApiUrl: string;
  /** App slug, or the value returned by defineApp (which also types collections and rows). */
  app: A;
}

export interface CollectionClient<R, I, P> {
  readonly name: string;
  list(query?: ListQuery<R>): Promise<R[]>;
  /** null when the row does not exist or the user cannot see it. */
  get(id: string): Promise<R | null>;
  create(values: I): Promise<R>;
  /** The updated row, or null when no row with that id is visible. A visible row the user may not change rejects with `denied`. */
  update(id: string, values: P): Promise<R | null>;
  /** Whether a row was deleted. */
  remove(id: string): Promise<boolean>;
}

export interface KelayClient<A extends AppRef = string> {
  readonly app: string;
  collection<N extends CollectionName<A>>(name: N): CollectionClient<Row<A, N>, NewRow<A, N>, RowPatch<A, N>>;
  /** Raw Data API call. Validated against the contract before it is sent. */
  query(req: QueryRequest): Promise<QueryResponse>;
}

export function appSlug(app: AppRef): string {
  const slug = typeof app === 'string' ? app : app.app;
  if (!SLUG.test(slug)) throw new KelayError('invalid_request', `invalid app slug ${JSON.stringify(slug)}`);
  return slug;
}

const QueryResponseShape = z.object({ rows: z.array(z.record(z.string(), z.unknown())), count: z.number() });

export function createKelayClient<A extends AppRef>(options: KelayClientOptions<A>): KelayClient<A> {
  const slug = appSlug(options.app);
  const url = joinUrl(options.dataApiUrl, `/v1/apps/${slug}/query`);
  const collections = typeof options.app === 'string' ? null : new Set(options.app.collections.map((c) => c.name));

  async function query(req: QueryRequest): Promise<QueryResponse> {
    const parsed = QueryRequest.safeParse(req);
    if (!parsed.success) throw new KelayError('invalid_request', `invalid query:\n${z.prettifyError(parsed.error)}`);
    if (collections && !collections.has(parsed.data.collection)) {
      throw new KelayError('unknown_collection', `app ${slug} has no collection ${parsed.data.collection}`);
    }
    const res = QueryResponseShape.safeParse(await postJson(url, parsed.data, options));
    if (!res.success) throw new KelayError('internal', 'Data API returned an unexpected response shape', { status: 200 });
    return res.data;
  }

  function collection<N extends CollectionName<A>>(name: N) {
    type R = Row<A, N>;
    const rows = (res: QueryResponse) => res.rows as R[];
    return {
      name,
      async list(q: ListQuery<R> = {}) {
        return rows(await query({ op: 'select', collection: name, ...q } as QueryRequest));
      },
      async get(id: string) {
        return rows(await query({ op: 'select', collection: name, where: { id }, limit: 1 }))[0] ?? null;
      },
      async create(values: NewRow<A, N>) {
        const row = rows(await query({ op: 'insert', collection: name, values: values as Record<string, unknown> }))[0];
        if (!row) throw new KelayError('internal', `insert into ${name} returned no row`, { status: 200 });
        return row;
      },
      async update(id: string, values: RowPatch<A, N>) {
        return rows(await query({ op: 'update', collection: name, where: { id }, values: values as Record<string, unknown> }))[0] ?? null;
      },
      async remove(id: string) {
        return (await query({ op: 'delete', collection: name, where: { id } })).count > 0;
      },
    } satisfies CollectionClient<R, NewRow<A, N>, RowPatch<A, N>>;
  }

  return { app: slug, collection, query };
}
