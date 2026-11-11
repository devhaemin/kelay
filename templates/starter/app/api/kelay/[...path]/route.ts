// Platform file, do not edit. Forwards the SDK's calls to the Data API (and /feedback to the Control
// API) as the signed-in person. The tokens come from the platform: the router sends the person's
// Kelay ID token in x-kelay-authorization, and the deploy gives this runtime its caller token.
import { CALLER_HEADER, USER_AUTHORIZATION_HEADER } from '@kelay/sdk';

const ROUTES: { path: RegExp; base: string | undefined }[] = [
  { path: /^v1\/apps\/[a-z][a-z0-9-]{1,62}\/query$/, base: process.env.DATA_API_URL },
  { path: /^v1\/apps\/[a-z][a-z0-9-]{1,62}\/feedback$/, base: process.env.CONTROL_API_URL },
];

const error = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join('/');
  const route = ROUTES.find((r) => r.path.test(path));
  if (!route) return error('not_found', `no route ${path}`, 404);

  const bearer = /^Bearer[ \t]+(\S+)$/i.exec(request.headers.get(USER_AUTHORIZATION_HEADER) ?? '')?.[1];
  const userToken = bearer ?? process.env.KELAY_DEV_USER_TOKEN;
  if (!userToken) return error('unauthenticated', 'Sign in with Kelay ID to load this app’s data.', 401);
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
