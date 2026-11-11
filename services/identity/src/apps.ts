// Registry apps as OAuth protected resources: one MCP resource per app (contract §7).
import type { AppRegistry } from '@kelay/contracts';

export interface AppResource {
  app: string;
  handle: string;
  /** `{MCP_PUBLIC_BASE_URL}/<handle>/<app>/mcp`: the RFC 8707 resource and the token `aud`. */
  resource: string;
}

export interface AppResources {
  list: AppResource[];
  /** The one app a request targets; undefined when it names no resource, several, or an unknown one. */
  single(resources: readonly string[] | undefined): AppResource | undefined;
}

export function mcpResourceUrl(mcpPublicBaseUrl: string, handle: string, app: string): string {
  return `${mcpPublicBaseUrl.replace(/\/+$/, '')}/${handle}/${app}/mcp`;
}

export function appResources(registry: AppRegistry, mcpPublicBaseUrl: string): AppResources {
  const list = Object.entries(registry.apps)
    .map(([app, entry]) => ({ app, handle: entry.handle, resource: mcpResourceUrl(mcpPublicBaseUrl, entry.handle, app) }))
    .sort((a, b) => a.app.localeCompare(b.app));
  const byResource = new Map(list.map((r) => [r.resource, r]));
  return {
    list,
    single(resources) {
      const unique = [...new Set(resources ?? [])];
      return unique.length === 1 ? byResource.get(unique[0]!) : undefined;
    },
  };
}
