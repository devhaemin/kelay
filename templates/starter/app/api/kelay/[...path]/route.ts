// Platform file, do not edit. Forwards the SDK's calls to the Data API (and /feedback to the Control
// API) as the signed-in person. The tokens come from the platform. Behind the router, the person's
// Kelay ID token arrives in x-kelay-authorization. A dev preview has no router in front of it: the
// browser sends its Kelay ID session cookie, which Kelay ID and the preview share, and this route
// trades it at Kelay ID for the person's token for this app. The deploy gives this runtime its caller token.
import { CALLER_HEADER, USER_AUTHORIZATION_HEADER } from '@kelay/sdk';

const ROUTES: { path: RegExp; base: string | undefined }[] = [
  { path: /^v1\/apps\/([a-z][a-z0-9-]{1,62})\/query$/, base: process.env.DATA_API_URL },
  { path: /^v1\/apps\/([a-z][a-z0-9-]{1,62})\/feedback$/, base: process.env.CONTROL_API_URL },
];
const SIGN_IN_PATH = 'signin';
const KELAY_ID = process.env.KELAY_ID_ISSUER?.replace(/\/+$/, '');

const error = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });
const signInFirst = () => error('unauthenticated', 'Sign in with Kelay ID to load this app’s data.', 401);

// Kelay ID tokens last 15 minutes, so one is asked for once per session and reused until shortly before it expires.
const MAX_CACHED = 500;
const cached = new Map<string, { token: string; until: number }>();

function expiryOf(token: string): number {
  try {
    return Number(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

/** The person's token for `app` from their Kelay ID session (`POST /v1/token`), or the error to answer with. */
async function tokenFromSession(request: Request, app: string): Promise<string | Response> {
  const cookie = request.headers.get('cookie');
  if (!KELAY_ID || !cookie) return signInFirst();
  const key = `${app} ${cookie}`;
  const hit = cached.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  cached.delete(key);

  let res: Response;
  try {
    res = await fetch(`${KELAY_ID}/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', cookie },
      body: JSON.stringify({ app }),
      cache: 'no-store',
    });
  } catch {
    return error('internal', 'Kelay ID could not be reached.', 502);
  }
  if (res.status === 401) return signInFirst();
  const body = (await res.json().catch(() => null)) as { token?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  // Signed in, but not a member of this app (or banned from it): Kelay ID's own answer says which.
  if (!res.ok) return error(typeof body?.error?.code === 'string' ? body.error.code : 'internal', typeof body?.error?.message === 'string' ? body.error.message : 'Kelay ID did not issue a token.', res.status);
  if (typeof body?.token !== 'string') return error('internal', 'Kelay ID did not issue a token.', 502);

  if (cached.size >= MAX_CACHED) cached.delete(cached.keys().next().value!);
  cached.set(key, { token: body.token, until: expiryOf(body.token) - 60_000 });
  return body.token;
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  const route = ROUTES.find((r) => r.path.test(path));
  if (!route) return error('not_found', `no route ${path}`, 404);
  const app = route.path.exec(path)![1]!;

  const bearer = /^Bearer[ \t]+(\S+)$/i.exec(request.headers.get(USER_AUTHORIZATION_HEADER) ?? '')?.[1];
  const userToken = bearer ?? process.env.KELAY_DEV_USER_TOKEN ?? (await tokenFromSession(request, app));
  if (userToken instanceof Response) return userToken;
  const callerToken = process.env.KELAY_CALLER_TOKEN;
  if (!route.base || !callerToken) return error('internal', 'This preview is not connected to the Kelay platform yet.', 500);

  let upstream: Response;
  try {
    upstream = await fetch(`${route.base.replace(/\/+$/, '')}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${userToken}`, [CALLER_HEADER]: callerToken },
      body: await request.text(),
      cache: 'no-store',
    });
  } catch {
    return error('internal', 'The Kelay platform could not be reached.', 502);
  }
  return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } });
}

/** `/api/kelay/signin`: Kelay ID's login page, which sends the browser back here once the person is signed in. */
export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  if (path !== SIGN_IN_PATH) return error('not_found', `no route ${path}`, 404);
  if (!KELAY_ID) return error('internal', 'This preview is not connected to the Kelay platform yet.', 500);
  const back = new URL('/', request.url);
  // The dev server may see its bind address; the browser's Host header is the address the person used.
  const host = request.headers.get('host');
  if (host) back.host = host;
  return Response.redirect(`${KELAY_ID}/login?${new URLSearchParams({ return_to: back.toString() })}`, 302);
}
