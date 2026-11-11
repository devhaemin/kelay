import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AwsV4Signer } from 'aws4fetch';
import worker, { ROUTE_HEADER, USER_AUTHORIZATION_HEADER, type Env } from './index.ts';
import { matchRoute } from './routes.ts';

const PROD_FN = 'https://prodfn123.lambda-url.ap-northeast-2.on.aws';
const DEV_FN = 'https://devfn456.lambda-url.us-west-2.on.aws/';
const KEY_ID = 'AKIDEXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const routes = new Map<string, string>();
const kvGet = vi.fn(async (key: string) => routes.get(key) ?? null);
const upstream = vi.fn(async (_request: Request) => new Response('from upstream', { status: 201 }));

const makeEnv = (over: Partial<Env> = {}): Env => ({
  ROUTES: { get: kvGet } as unknown as KVNamespace,
  MCP_ORIGIN: 'https://mcp.internal.test',
  CONTROL_ORIGIN: 'https://control.internal.test/',
  AWS_REGION: 'ap-northeast-2',
  AWS_ACCESS_KEY_ID: KEY_ID,
  AWS_SECRET_ACCESS_KEY: SECRET,
  ...over,
});

async function call(url: string, init?: RequestInit, env = makeEnv()) {
  const response = await worker.fetch(new Request(url, init) as Parameters<typeof worker.fetch>[0], env);
  return { response, sent: upstream.mock.calls[0]?.[0] };
}

const sha256Hex = async (data: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const forged = {
  authorization: 'Bearer user.jwt',
  'x-kelay-caller': 'forged.caller.token',
  'x-kelay-route': 'evil/app/prod',
  'x-kelay-authorization': 'Bearer someone-else',
};

beforeEach(() => {
  vi.stubGlobal('fetch', upstream);
  routes.clear();
  routes.set('app:orum/ticket-board', JSON.stringify({ prod: { origin: PROD_FN }, dev: { origin: DEV_FN, region: 'us-west-2' } }));
  routes.set('app:orum/wiki', JSON.stringify({ prod: { origin: 'http://localhost:3000/' } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('MCP gateway routes', () => {
  it('forwards /:handle/:app/mcp with the path, query, body and user token, stripping x-kelay-* headers', async () => {
    const { response, sent } = await call('https://kelay.app/orum/ticket-board/mcp?session=1', {
      method: 'POST',
      headers: { ...forged, 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(response.status).toBe(201);
    expect(sent!.url).toBe('https://mcp.internal.test/orum/ticket-board/mcp?session=1');
    expect(sent!.method).toBe('POST');
    expect(await sent!.text()).toBe('{"jsonrpc":"2.0"}');
    expect(sent!.headers.get('authorization')).toBe('Bearer user.jwt');
    expect(sent!.headers.get('x-kelay-caller')).toBeNull();
    expect(sent!.headers.get(USER_AUTHORIZATION_HEADER)).toBeNull();
    expect(sent!.headers.get(ROUTE_HEADER)).toBe('orum/ticket-board/prod');
    expect(sent!.headers.get('x-forwarded-host')).toBe('kelay.app');
    expect(sent!.redirect).toBe('manual');
    expect(kvGet).not.toHaveBeenCalled();
  });

  it.each([
    '/.well-known/oauth-protected-resource/orum/ticket-board/mcp',
    '/orum/ticket-board/mcp/messages',
    '/orum/ticket-board/.well-known/agent-card.json',
  ])('forwards %s to the gateway unchanged', async (path) => {
    const { sent } = await call(`https://kelay.app${path}`);
    expect(sent!.url).toBe(`https://mcp.internal.test${path}`);
  });

  it('tags dev-host MCP calls with the dev env', async () => {
    const { sent } = await call('https://dev.kelay.app/orum/ticket-board/mcp', { method: 'POST', body: '{}' });
    expect(sent!.headers.get(ROUTE_HEADER)).toBe('orum/ticket-board/dev');
  });
});

describe('app routes', () => {
  it('signs requests to a Lambda function URL with SigV4 and moves the user token aside', async () => {
    const { response, sent } = await call('https://kelay.app/orum/ticket-board/tickets?status=todo', {
      headers: { ...forged, 'x-amz-security-token': 'forged', accept: 'text/html' },
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('from upstream');
    expect(kvGet).toHaveBeenCalledWith('app:orum/ticket-board', expect.objectContaining({ cacheTtl: expect.any(Number) }));

    expect(sent!.url).toBe(`${PROD_FN}/orum/ticket-board/tickets?status=todo`);
    const authorization = sent!.headers.get('authorization')!;
    expect(authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/ap-northeast-2\/lambda\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(sent!.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/);
    expect(sent!.headers.get('x-amz-content-sha256')).toBe(await sha256Hex(''));
    expect(sent!.headers.get('x-amz-security-token')).toBeNull();
    expect(sent!.headers.get(USER_AUTHORIZATION_HEADER)).toBe('Bearer user.jwt');
    expect(sent!.headers.get('x-kelay-caller')).toBeNull();
    expect(sent!.headers.get(ROUTE_HEADER)).toBe('orum/ticket-board/prod');
    expect(sent!.headers.get('x-forwarded-host')).toBe('kelay.app');
    expect(sent!.headers.get('accept')).toBe('text/html');
    expect(sent!.redirect).toBe('manual');
  });

  it('signs the body it forwards', async () => {
    const body = '{"title":"Fix the login page"}';
    const { sent } = await call('https://kelay.app/orum/ticket-board/api/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(await sent!.clone().text()).toBe(body);
    const hash = await sha256Hex(body);
    expect(sent!.headers.get('x-amz-content-sha256')).toBe(hash);

    const expected = await new AwsV4Signer({
      url: sent!.url,
      method: 'POST',
      headers: { 'x-amz-content-sha256': hash },
      body,
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      service: 'lambda',
      region: 'ap-northeast-2',
      datetime: sent!.headers.get('x-amz-date')!,
    }).authHeader();
    expect(sent!.headers.get('authorization')).toBe(expected);
  });

  it('selects the dev origin and its region on a dev. host', async () => {
    const { sent } = await call('https://dev.kelay.app/orum/ticket-board');
    expect(sent!.url).toBe('https://devfn456.lambda-url.us-west-2.on.aws/orum/ticket-board');
    expect(sent!.headers.get('authorization')).toContain('/us-west-2/lambda/aws4_request');
    expect(sent!.headers.get(ROUTE_HEADER)).toBe('orum/ticket-board/dev');
  });

  it('forwards to a non-Lambda origin unsigned, keeping authorization', async () => {
    const { sent } = await call('https://kelay.app/orum/wiki/pages/1', { headers: forged });
    expect(sent!.url).toBe('http://localhost:3000/orum/wiki/pages/1');
    expect(sent!.headers.get('authorization')).toBe('Bearer user.jwt');
    expect(sent!.headers.get('x-amz-date')).toBeNull();
    expect(sent!.headers.get(USER_AUTHORIZATION_HEADER)).toBeNull();
    expect(sent!.headers.get(ROUTE_HEADER)).toBe('orum/wiki/prod');
  });

  it('answers 404 unknown_app for an app missing from the route table', async () => {
    const { response, sent } = await call('https://kelay.app/orum/nope/x');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'unknown_app', message: 'No app orum/nope.' } });
    expect(sent).toBeUndefined();
  });

  it('answers 404 unknown_app when the app has no dev environment', async () => {
    const { response, sent } = await call('https://dev.kelay.app/orum/wiki');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'unknown_app' } });
    expect(sent).toBeUndefined();
  });

  it('answers 500 internal for a malformed route entry or missing AWS credentials', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    routes.set('app:orum/broken', '{"prod":{"origin":"ftp://x"}}');
    const broken = await call('https://kelay.app/orum/broken');
    expect(broken.response.status).toBe(500);
    expect(await broken.response.json()).toMatchObject({ error: { code: 'internal' } });

    const noKeys = await call('https://kelay.app/orum/ticket-board', undefined, makeEnv({ AWS_ACCESS_KEY_ID: undefined }));
    expect(noKeys.response.status).toBe(500);
    expect(noKeys.sent).toBeUndefined();
  });
});

describe('store and unknown paths', () => {
  it.each(['/orum', '/orum/'])('serves %s from the control API store page', async (path) => {
    const { sent } = await call(`https://kelay.app${path}?lang=ko`, { headers: forged });
    expect(sent!.url).toBe('https://control.internal.test/public/v1/stores/orum?lang=ko');
    expect(sent!.headers.get('x-kelay-caller')).toBeNull();
    expect(sent!.headers.get('x-forwarded-host')).toBe('kelay.app');
  });

  it.each(['/', '/favicon.ico', '/Orum/ticket-board', '/orum/Ticket_Board/x', '/.well-known/oauth-protected-resource/orum/ticket-board'])(
    'answers 404 unknown_app for %s without touching KV',
    async (path) => {
      const { response, sent } = await call(`https://kelay.app${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: { code: 'unknown_app' } });
      expect(sent).toBeUndefined();
      expect(kvGet).not.toHaveBeenCalled();
    },
  );
});

describe('matchRoute', () => {
  it('classifies paths', () => {
    expect(matchRoute('/orum/ticket-board/mcp')).toEqual({ kind: 'mcp', handle: 'orum', app: 'ticket-board' });
    expect(matchRoute('/orum/ticket-board/mcpx')).toEqual({ kind: 'app', handle: 'orum', app: 'ticket-board' });
    expect(matchRoute('/orum/ticket-board/.well-known/other')).toEqual({ kind: 'app', handle: 'orum', app: 'ticket-board' });
    expect(matchRoute('/orum')).toEqual({ kind: 'store', handle: 'orum' });
    expect(matchRoute('/.well-known/openid-configuration')).toEqual({ kind: 'none' });
  });
});
