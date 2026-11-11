// In-process test rig: the ticket-board fixture registry, a dev Kelay ID signer, a fake Data API that
// validates queries against contract §5, and an MCP client from the official SDK.
import { createRequire } from 'node:module';
import { CALLER_HEADER, QueryRequest, type CallerClaims, type KelayClaims } from '@kelay/contracts';
import { loadAppRegistry, staticRegistrySource, type AppRegistrySource } from '@kelay/contracts/registry';
import { createDevSigner, verifyCallerToken } from '@kelay/tokens';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Hono } from 'hono';
import { createGateway, type ActionRunner, type AppLinks, type McpCallRecord, type OAuthEndpoints } from '../src/index.ts';

const require = createRequire(import.meta.url);
export const registry = loadAppRegistry(require.resolve('@kelay/contracts/fixtures/apps.local.json'));

export const BASE = 'https://apps.kelay.test';
export const MCP_PATH = '/orum/ticket-board/mcp';
export const RESOURCE = `${BASE}${MCP_PATH}`;
export const METADATA_URL = `${BASE}/.well-known/oauth-protected-resource/orum/ticket-board/mcp`;
export const CLIENT_ID = 'https://assistant.example/oauth/client-metadata.json';
export const CALLER_SECRET = 'test-caller-secret-0123456789abcdef';
export const OAUTH: OAuthEndpoints = {
  authorizationUrl: 'https://id.kelay.test/api/auth/oauth2/authorize',
  tokenUrl: 'https://id.kelay.test/api/auth/oauth2/token',
  metadataUrl: 'https://id.kelay.test/.well-known/oauth-authorization-server',
};
const PROTOCOL_VERSION = '2026-07-28';

export interface RecordedQuery {
  app: string;
  authorization: string | undefined;
  caller: CallerClaims | undefined;
  body: unknown;
}

/** Data API stand-in. Rejects anything that is not a valid QueryRequest, like the real one. */
export function fakeDataApi() {
  const queries: RecordedQuery[] = [];
  let reply: (query: QueryRequest) => Response | Promise<Response> = () => Response.json({ rows: [], count: 0 });
  const api = new Hono();
  api.post('/v1/apps/:app/query', async (c) => {
    const body: unknown = await c.req.json();
    const callerToken = c.req.header(CALLER_HEADER);
    const caller = callerToken ? await verifyCallerToken(callerToken, CALLER_SECRET).catch(() => undefined) : undefined;
    queries.push({ app: c.req.param('app'), authorization: c.req.header('authorization'), caller, body });
    const parsed = QueryRequest.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: 'invalid_request', message: parsed.error.message } }, 400);
    return reply(parsed.data);
  });
  return {
    queries,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => api.fetch(new Request(input, init))) as typeof fetch,
    reply(fn: typeof reply) {
      reply = fn;
    },
  };
}

export const denied = (message = 'permission denied') => Response.json({ error: { code: 'denied', message } }, { status: 403 });

export async function setup(opts: { ratePerMin?: number; actions?: ActionRunner | ((signer: Awaited<ReturnType<typeof createDevSigner>>) => ActionRunner); links?: AppLinks; registry?: AppRegistrySource } = {}) {
  const signer = await createDevSigner();
  const data = fakeDataApi();
  const calls: McpCallRecord[] = [];
  const errors: Error[] = [];
  const clock = { now: 0 };
  const gateway = createGateway({
    config: {
      publicBaseUrl: BASE,
      issuer: signer.issuer,
      dataApiUrl: 'http://data-api.test',
      callerSecret: CALLER_SECRET,
      ratePerMin: opts.ratePerMin,
      oauth: OAUTH,
    },
    registry: opts.registry ?? staticRegistrySource(registry),
    jwks: signer.verifier,
    fetch: data.fetch,
    now: () => clock.now,
    meter: (record) => calls.push(record),
    onError: (error) => errors.push(error),
    ...(opts.actions ? { actions: typeof opts.actions === 'function' ? opts.actions(signer) : opts.actions } : {}),
    ...(opts.links ? { links: opts.links } : {}),
  });

  const token = (claims: Partial<KelayClaims> = {}) =>
    signer.sign({ sub: 'u_1', app: 'ticket-board', org: 'orum', role: 'member', plan: 'free', aud: RESOURCE, azp: CLIENT_ID, ...claims });

  /** Connects in-process, or over the network when `url` points at a listening server. */
  async function connect(bearer: string, url?: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(url ?? RESOURCE), {
      ...(url ? {} : { fetch: async (input: string | URL, init?: RequestInit) => gateway.fetch(new Request(input, init)) }),
      authProvider: { token: async () => bearer },
    });
    const client = new Client({ name: 'test-assistant', version: '1.0.0' }, { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } });
    await client.connect(transport);
    return client;
  }

  /** A raw 2026-07-28 JSON-RPC request, for status codes and headers the SDK client hides. */
  async function rpc(bearer: string | undefined, method: string, path = MCP_PATH): Promise<Response> {
    return gateway.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': method,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
  }

  return { gateway, signer, data, calls, errors, clock, token, connect, rpc };
}
