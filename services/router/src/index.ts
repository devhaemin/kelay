// Router Worker: path routing for `/<handle>/<app>` on the app domain (infrastructure §1, §4.2).
import { AwsV4Signer } from 'aws4fetch';
import { HTTP_STATUS, type ErrorCode, type ErrorResponse } from '@kelay/contracts';
import { AppRoute, isLambdaFunctionUrl, matchRoute, routeKey, type AppTarget } from './routes.ts';

export interface Env {
  ROUTES: KVNamespace;
  MCP_ORIGIN: string;
  CONTROL_ORIGIN: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

/**
 * SigV4 occupies `authorization` on requests to Lambda function URLs, so the caller's own
 * `authorization` (the user token) travels to the app in this header instead.
 */
export const USER_AUTHORIZATION_HEADER = 'x-kelay-authorization';
export const ROUTE_HEADER = 'x-kelay-route';

const ROUTE_CACHE_TTL_SECONDS = 60;

function errorResponse(code: ErrorCode, message: string): Response {
  const body: ErrorResponse = { error: { code, message } };
  return Response.json(body, { status: HTTP_STATUS[code] });
}

const joinUrl = (origin: string, pathAndQuery: string): URL => new URL(origin.replace(/\/+$/, '') + pathAndQuery);

/** Inbound `x-kelay-*` headers are never trusted; only the router sets them. */
function outboundHeaders(request: Request, route?: string): Headers {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith('x-kelay-')) headers.delete(name);
  headers.delete('host');
  headers.set('x-forwarded-host', new URL(request.url).host);
  if (route) headers.set(ROUTE_HEADER, route);
  return headers;
}

function forward(request: Request, target: URL, headers: Headers): Promise<Response> {
  return fetch(new Request(new Request(target, request), { headers, redirect: 'manual' }));
}

async function forwardSigned(request: Request, target: URL, headers: Headers, region: string, env: Env): Promise<Response> {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    console.error('router: AWS credentials are not configured; cannot reach', target.host);
    return errorResponse('internal', 'The app origin is unavailable.');
  }
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const userAuthorization = headers.get('authorization');
  headers.delete('authorization');
  if (userAuthorization) headers.set(USER_AUTHORIZATION_HEADER, userAuthorization);
  for (const name of [...headers.keys()]) if (name.startsWith('x-amz-')) headers.delete(name);

  const bodyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body ?? new ArrayBuffer(0)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // Only host, x-amz-date and the payload hash are signed: the edge may rewrite other forwarded headers.
  const signed = await new AwsV4Signer({
    url: target.toString(),
    method: request.method,
    headers: { 'x-amz-content-sha256': bodyHash },
    ...(body ? { body } : {}),
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    service: 'lambda',
    region,
  }).sign();
  for (const [name, value] of signed.headers) headers.set(name, value);
  return fetch(new Request(signed.url, { method: request.method, headers, ...(body ? { body } : {}), redirect: 'manual' }));
}

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
  return forwardSigned(request, destination, headers, target.region ?? env.AWS_REGION, env);
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
