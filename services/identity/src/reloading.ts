// Kelay ID over a registry that changes while it runs (KELAY_APPS_SOURCE=control-api). better-auth
// takes its protected resources once, when an instance is created, so a changed app list is served
// by a new instance. Instances share the database, which holds every session, key, client and consent.
import type { AppSummary } from '@kelay/contracts';
import { createIdentity, type Identity, type IdentityDeps } from './index.ts';

export interface ReloadingIdentityOptions {
  /** Lists the apps people can connect assistants to, e.g. a `controlApiRegistrySource`. */
  source: { list(): Promise<AppSummary[]> };
  /** How often the list is read again. @default 30000 */
  refreshMs?: number;
  /** A failed read keeps the current instance; this hears about it. */
  onError?: (error: Error) => void;
  onReload?: (apps: AppSummary[]) => void;
}

export interface ReloadingIdentity {
  fetch(request: Request): Response | Promise<Response>;
  /** The instance serving requests now. */
  current(): Identity;
  /** Reads the app list now and swaps the instance when it changed. */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Starts with whatever the source lists now. When the first read fails it starts without apps, so
 * people can still sign in while the control API is away, and picks the apps up at the next refresh.
 */
export async function createReloadingIdentity(deps: Omit<IdentityDeps, 'registry'>, opts: ReloadingIdentityOptions): Promise<ReloadingIdentity> {
  const build = (apps: AppSummary[]) =>
    createIdentity({ ...deps, registry: { apps: Object.fromEntries(apps.map((a) => [a.app, { handle: a.handle }])) } });
  const keyOf = (apps: AppSummary[]) => JSON.stringify(apps.map((a) => [a.app, a.handle]).sort());

  let key: string | undefined;
  let identity = build([]);

  async function refresh(): Promise<void> {
    let apps: AppSummary[];
    try {
      apps = await opts.source.list();
    } catch (e) {
      opts.onError?.(e as Error);
      return;
    }
    const next = keyOf(apps);
    if (next === key) return;
    identity = build(apps);
    key = next;
    opts.onReload?.(apps);
  }

  await refresh();
  const timer = setInterval(() => void refresh(), opts.refreshMs ?? 30_000);
  timer.unref();

  return {
    fetch: (request) => identity.app.fetch(request),
    current: () => identity,
    refresh,
    stop: () => clearInterval(timer),
  };
}
