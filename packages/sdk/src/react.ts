// React bindings on TanStack Query. Hooks surface `denied` and errors as state and never throw,
// so a screen keeps rendering when the server refuses an action.
import {
  QueryClient,
  QueryClientProvider,
  useMutation as useQueryMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createContext, createElement, useContext, useState, type ReactNode } from 'react';
import type { KelayClient } from './client.ts';
import { KelayError, toKelayError } from './errors.ts';
import type { RegisteredApp } from './index.ts';
import { safeMutation, type SafeHandlers, type SafeResult } from './safe.ts';
import type { AppRef, CollectionName, ListQuery, Row } from './types.ts';

// Stored untyped in context; the hooks re-type it from Register (or an explicit type argument).
type AnyKelayClient = KelayClient<any>;

const KelayContext = createContext<AnyKelayClient | null>(null);

export interface KelayProviderProps {
  client: AnyKelayClient;
  /** Pass one to share a cache with the rest of the app; otherwise the provider creates its own. */
  queryClient?: QueryClient;
  children?: ReactNode;
}

export function KelayProvider({ client, queryClient, children }: KelayProviderProps) {
  const [ownQueryClient] = useState(() => new QueryClient());
  return createElement(
    QueryClientProvider,
    { client: queryClient ?? ownQueryClient },
    createElement(KelayContext.Provider, { value: client }, children),
  );
}

export function useKelayClient<A extends AppRef = RegisteredApp>(): KelayClient<A> {
  const client = useContext(KelayContext);
  if (!client) throw new Error('useKelayClient must be used inside <KelayProvider>');
  return client;
}

/** Query key prefix for an app, or for one collection of it. */
export const kelayQueryKey = (app: string, collection?: string): readonly unknown[] =>
  collection === undefined ? ['kelay', app] : ['kelay', app, collection];

const retryable = (failures: number, e: unknown) =>
  failures < 2 && e instanceof KelayError && (e.code === 'network' || e.status >= 500);

const NO_ROWS: never[] = [];

export interface CollectionState<R> {
  rows: R[];
  loading: boolean;
  error: KelayError | null;
  /** The user's role may not read this collection. */
  denied: boolean;
  refetch: () => void;
}

export function useCollection<A extends AppRef = RegisteredApp, N extends CollectionName<A> = CollectionName<A>>(
  name: N,
  query?: ListQuery<Row<A, N>>,
): CollectionState<Row<A, N>> {
  const client = useKelayClient<A>();
  const q = useQuery({
    queryKey: [...kelayQueryKey(client.app, name), query ?? null],
    queryFn: () => client.collection(name).list(query),
    retry: retryable,
  });
  const error = q.error ? toKelayError(q.error) : null;
  return {
    rows: q.data ?? NO_ROWS,
    loading: q.isPending,
    error,
    denied: error?.isDenied() ?? false,
    refetch: () => void q.refetch(),
  };
}

export interface MutationOptions<T> extends SafeHandlers {
  /** Collections whose useCollection data refetches after success. Defaults to every collection of the app. */
  invalidates?: readonly string[];
  onSuccess?: (data: T) => void;
}

export interface MutationState<Args extends unknown[], T> {
  /** Never rejects: resolves with `ok`, `denied` or `error`. */
  mutate: (...args: Args) => Promise<SafeResult<T>>;
  pending: boolean;
  data: T | undefined;
  error: KelayError | null;
  denied: boolean;
  reset: () => void;
}

export function useMutation<Args extends unknown[], T, A extends AppRef = RegisteredApp>(
  fn: (client: KelayClient<A>, ...args: Args) => Promise<T>,
  options: MutationOptions<T> = {},
): MutationState<Args, T> {
  const client = useKelayClient<A>();
  const queryClient = useQueryClient();
  const m = useQueryMutation<T, KelayError, Args>({
    mutationFn: async (args) => {
      try {
        return await fn(client, ...args);
      } catch (e) {
        throw toKelayError(e);
      }
    },
    onSuccess: async (data) => {
      options.onSuccess?.(data);
      const keys = options.invalidates?.map((c) => kelayQueryKey(client.app, c)) ?? [kelayQueryKey(client.app)];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
  });
  return {
    mutate: (...args) => safeMutation(() => m.mutateAsync(args), options),
    pending: m.isPending,
    data: m.data,
    error: m.error,
    denied: m.error?.isDenied() ?? false,
    reset: m.reset,
  };
}
