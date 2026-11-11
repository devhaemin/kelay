import { AwsV4Signer } from 'aws4fetch';
import { HTTP_STATUS, type ErrorCode, type ErrorResponse } from '@kelay/contracts';

/**
 * SigV4 occupies `authorization` on requests to Lambda function URLs, so the caller's own
 * `authorization` (the user token) travels to the app in this header instead.
 */
export const USER_AUTHORIZATION_HEADER = 'x-kelay-authorization';
export const ROUTE_HEADER = 'x-kelay-route';

export function errorResponse(code: ErrorCode, message: string): Response {
  const body: ErrorResponse = { error: { code, message } };
  return Response.json(body, { status: HTTP_STATUS[code] });
}

export const joinUrl = (origin: string, pathAndQuery: string): URL => new URL(origin.replace(/\/+$/, '') + pathAndQuery);

/** Inbound `x-kelay-*` headers are never trusted; only the router sets them. */
export function outboundHeaders(request: Request, route?: string): Headers {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith('x-kelay-')) headers.delete(name);
  headers.delete('host');
  headers.set('x-forwarded-host', new URL(request.url).host);
  if (route) headers.set(ROUTE_HEADER, route);
  return headers;
}

export function forward(request: Request, target: URL, headers: Headers): Promise<Response> {
  return fetch(new Request(new Request(target, request), { headers, redirect: 'manual' }));
}

export interface SigningKey {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export async function forwardSigned(request: Request, target: URL, headers: Headers, key: SigningKey): Promise<Response> {
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
    accessKeyId: key.accessKeyId,
    secretAccessKey: key.secretAccessKey,
    service: 'lambda',
    region: key.region,
  }).sign();
  for (const [name, value] of signed.headers) headers.set(name, value);
  return fetch(new Request(signed.url, { method: request.method, headers, ...(body ? { body } : {}), redirect: 'manual' }));
}
