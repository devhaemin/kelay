import { SLUG } from '@kelay/contracts';

// The route table's key and value are in @kelay/contracts: the control API writes what this Worker reads.
export { AppRoute, routeKey, type AppRouteTarget as AppTarget } from '@kelay/contracts';

export type Route =
  | { kind: 'mcp'; handle: string; app: string }
  | { kind: 'app'; handle: string; app: string }
  | { kind: 'store'; handle: string }
  | { kind: 'none' };

const isSlug = (s: string | undefined): s is string => s !== undefined && SLUG.test(s);

/**
 * Classifies a request path. Paths the MCP · A2A gateway serves (contract §7):
 * `/:handle/:app/mcp[/…]`, `/:handle/:app/.well-known/agent-card.json` and
 * `/.well-known/oauth-protected-resource/:handle/:app/mcp[/…]`.
 */
export function matchRoute(pathname: string): Route {
  const segs = pathname.split('/').filter(Boolean);
  if (segs[0] === '.well-known') {
    const [, kind, handle, app, mcp] = segs;
    return kind === 'oauth-protected-resource' && isSlug(handle) && isSlug(app) && mcp === 'mcp'
      ? { kind: 'mcp', handle, app }
      : { kind: 'none' };
  }
  const [handle, app, third, fourth] = segs;
  if (!isSlug(handle)) return { kind: 'none' };
  if (app === undefined) return { kind: 'store', handle };
  if (!isSlug(app)) return { kind: 'none' };
  if (third === 'mcp' || (third === '.well-known' && fourth === 'agent-card.json')) return { kind: 'mcp', handle, app };
  return { kind: 'app', handle, app };
}

/** Lambda function URL hosts look like `<url-id>.lambda-url.<region>.on.aws`. */
export const isLambdaFunctionUrl = (hostname: string): boolean => /^[^.]+\.lambda-url\.[a-z0-9-]+\.on\.aws$/.test(hostname);
