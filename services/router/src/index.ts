// Router Worker: path routing for `/<handle>/<app>` on the app domain (infrastructure §1, §4.2).
// workerd treats every value exported from this module as an entrypoint, so only the handler is exported here.
import { errorResponse, forward, forwardSigned, joinUrl, outboundHeaders } from './forward.ts';
import { AppRoute, isLambdaFunctionUrl, matchRoute, routeKey, type AppTarget } from './routes.ts';

export interface Env {
  ROUTES: KVNamespace;
  MCP_ORIGIN: string;
  CONTROL_ORIGIN: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

const ROUTE_CACHE_TTL_SECONDS = 60;

async function lookupApp(env: Env, handle: string, app: string): Promise<AppRoute | null | 'malformed'> {
  const raw = await env.ROUTES.get(routeKey(handle, app), { cacheTtl: ROUTE_CACHE_TTL_SECONDS });
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = AppRoute.safeParse(json);
  if (parsed.success) return parsed.data;
  console.error(`router: malformed route entry ${routeKey(handle, app)}`, parsed.error.message);
  return 'malformed';
}

async function routeToApp(request: Request, env: Env, handle: string, app: string, appEnv: 'dev' | 'prod'): Promise<Response> {
  const entry = await lookupApp(env, handle, app);
  if (entry === 'malformed') return errorResponse('internal', 'The route table entry for this app is invalid.');
  const target: AppTarget | undefined = entry?.[appEnv];
  if (!target) {
    return errorResponse('unknown_app', entry ? `${handle}/${app} has no ${appEnv} environment.` : `No app ${handle}/${app}.`);
  }
  const url = new URL(request.url);
  const destination = joinUrl(target.origin, url.pathname + url.search);
  const headers = outboundHeaders(request, `${handle}/${app}/${appEnv}`);
  if (!isLambdaFunctionUrl(destination.hostname)) return forward(request, destination, headers);
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    console.error('router: AWS credentials are not configured; cannot reach', destination.host);
    return errorResponse('internal', 'The app origin is unavailable.');
  }
  return forwardSigned(request, destination, headers, {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: target.region ?? env.AWS_REGION,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const appEnv = url.hostname.startsWith('dev.') ? 'dev' : 'prod';
    const route = matchRoute(url.pathname);
    switch (route.kind) {
      case 'mcp':
        return forward(
          request,
          joinUrl(env.MCP_ORIGIN, url.pathname + url.search),
          outboundHeaders(request, `${route.handle}/${route.app}/${appEnv}`),
        );
      case 'store':
        return forward(request, joinUrl(env.CONTROL_ORIGIN, `/public/v1/stores/${route.handle}${url.search}`), outboundHeaders(request));
      case 'app':
        return routeToApp(request, env, route.handle, route.app, appEnv);
      case 'none':
        return errorResponse('unknown_app', `No app is served at ${url.pathname}.`);
    }
  },
} satisfies ExportedHandler<Env>;
