import 'server-only';
import { cookies } from 'next/headers';
import { TOKEN_COOKIE, dataMode } from './server';

const error = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });

/**
 * Forwards a request to the Builder with the builder's token from the httpOnly cookie, so the token
 * never reaches browser code. The Builder's answer goes back as it is, including an event stream.
 */
export async function builderProxy(path: string, init: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  if (dataMode() !== 'http') return error('not_found', 'The Builder is only available with CONSOLE_DATA=http.', 404);
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  if (!token) return error('unauthenticated', 'Sign in again.', 401);

  let upstream: Response;
  try {
    upstream = await fetch(new URL(path, builderUrl()), {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal ? { signal: init.signal } : {}),
      cache: 'no-store',
    });
  } catch {
    return error('internal', 'The Builder could not be reached.', 502);
  }
  const headers = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
  // Tells a proxy in front of the console not to buffer the event stream.
  if (headers.get('content-type')?.includes('text/event-stream')) headers.set('x-accel-buffering', 'no');
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const builderUrl = (): string => process.env.BUILDER_URL ?? 'http://localhost:4006';
