// MCP · A2A gateway (contract §7): one stateless MCP server per app, generated from the app's schema.
// Users' own assistants call it with a Kelay ID token bound to the app's MCP resource; every tool call
// reaches the Data API with that same token, so the user's RLS applies.
import { createHash } from 'node:crypto';
import { HTTP_STATUS, type AppRegistryEntry, type ErrorCode, type ErrorResponse } from '@kelay/contracts';
import type { AppRegistrySource } from '@kelay/contracts/registry';
import type { VerifyOptions } from '@kelay/tokens';
import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  readRequestBody,
  type AuthInfo,
  type CallToolResult,
  type McpHttpHandler,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { unavailableActionRunner, type ActionRunner } from './actions.ts';
import { buildAgentCard, kelayIdOAuthEndpoints, type OAuthEndpoints } from './agent-card.ts';
import { appUrls, authenticate, challengeHeader, protectedResourceMetadata, type AppUrls, type AuthResult } from './auth.ts';
import { createDataApi, type DataApi } from './data-api.ts';
import { stdoutMeter, type MeterSink } from './metering.ts';
import { createRateLimiter, type RateLimiter } from './rate-limit.ts';
import { buildTools, present, toQuery, toolError, type ToolDef } from './tools.ts';

export interface GatewayConfig {
  /** MCP_PUBLIC_BASE_URL: the origin clients see; resource URLs are built from it. */
  publicBaseUrl: string;
  /** KELAY_ID_ISSUER */
  issuer: string;
  /** DATA_API_URL */
  dataApiUrl: string;
  /** KELAY_CALLER_SECRET */
  callerSecret: string;
  /** MCP_RATE_PER_MIN, default 60. */
  ratePerMin?: number;
  /** Kelay ID OAuth endpoints, advertised in the A2A agent card. Defaults to `kelayIdOAuthEndpoints(issuer)`. */
  oauth?: OAuthEndpoints;
}

export interface GatewayDeps {
  config: GatewayConfig;
  /** Where apps are looked up (contract §6). The gateway serves each app's production deployment. */
  registry: AppRegistrySource;
  /** Kelay ID key set (`remoteJwks(KELAY_ID_JWKS_URL)` in production). */
  jwks: VerifyOptions['jwks'];
  /** Transport for Data API calls. */
  fetch?: typeof fetch;
  /** Milliseconds; drives rate limiting, caller-token refresh and call durations. */
  now?: () => number;
  meter?: MeterSink;
  actions?: ActionRunner;
  onError?: (error: Error) => void;
}

type Caller = Extract<AuthResult, { ok: true }>;

type Args = Record<string, unknown>;

interface PreparedTool {
  def: ToolDef;
  strict: StandardSchemaWithJSON<Args, Args>;
  /** Same JSON Schema in `tools/list`, but accepts anything; `strict` runs inside callTool. */
  advertised: StandardSchemaWithJSON<Args, Args>;
}

interface PreparedApp {
  slug: string;
  entry: AppRegistryEntry;
  urls: AppUrls;
  version: string;
  card: ReturnType<typeof buildAgentCard>;
  mcp: McpHttpHandler;
}

const INTERNAL_FAILURE = 'Something went wrong on Kelay while handling this request. Try again shortly.';
/** A2A JSON-RPC UnsupportedOperationError (A2A specification 1.0, §5.4 error mappings). */
const A2A_UNSUPPORTED_OPERATION = -32004;

const errorBody = (code: ErrorCode, message: string): ErrorResponse => ({ error: { code, message } });

const ARGS_SUMMARY_LENGTH = 200;

/** Arguments as the Monitoring and Agent tabs show them: compact JSON, cut short. */
function argsSummary(args: Args): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? '';
  } catch {
    text = '';
  }
  return text.length > ARGS_SUMMARY_LENGTH ? `${text.slice(0, ARGS_SUMMARY_LENGTH - 1)}…` : text;
}

const methodOf = (message: unknown): unknown =>
  typeof message === 'object' && message !== null && !Array.isArray(message) ? (message as { method?: unknown }).method : undefined;

export function createGateway(deps: GatewayDeps): Hono {
  const { config, jwks } = deps;
  const now = deps.now ?? (() => performance.now());
  const meter = deps.meter ?? stdoutMeter;
  const actions = deps.actions ?? unavailableActionRunner;
  const onError = deps.onError ?? ((error: Error) => console.error(error));
  const ratePerMin = config.ratePerMin ?? 60;
  const limiter: RateLimiter = createRateLimiter({ perMinute: ratePerMin, now });
  const dataApi: DataApi = createDataApi({
    baseUrl: config.dataApiUrl,
    callerSecret: config.callerSecret,
    fetch: deps.fetch ?? fetch,
    now,
  });

  const oauth = config.oauth ?? kelayIdOAuthEndpoints(config.issuer);
  // One assistant product serves many apps; a busy app must not use up the client's budget for the others.
  const rateKeys = (app: string, caller: Caller): string[] => [`user:${app}:${caller.claims.sub}`, `client:${app}:${caller.claims.azp}`];

  async function execute(app: PreparedApp, tool: PreparedTool, raw: Args, caller: Caller, outcome: { denied?: true }): Promise<CallToolResult> {
    const { def } = tool;
    const verdict = limiter.take(rateKeys(app.slug, caller));
    if (!verdict.ok) {
      return toolError(`Rate limit reached (${ratePerMin} calls per minute). Try again in ${verdict.retryAfterSeconds} seconds.`);
    }
    const checked = await tool.strict['~standard'].validate(raw);
    if (checked.issues) return toolError(`Invalid arguments for ${def.name}: ${checked.issues.map((i) => i.message).join('; ')}`);
    const args = checked.value;
    const { target } = def;
    if (target.kind === 'action') {
      const ran = await actions.run({ app: app.slug, action: target.action, input: args, claims: caller.claims, userToken: caller.token });
      if (!ran.ok) return toolError(ran.message);
      const { output } = ran;
      const isObject = typeof output === 'object' && output !== null && !Array.isArray(output);
      return {
        content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }],
        ...(isObject ? { structuredContent: output as Record<string, unknown> } : {}),
      };
    }
    const result = await dataApi.query(app.slug, caller.token, toQuery(target.op, target.collection.name, args));
    if (!result.ok && ['internal', 'unreachable', 'forbidden_caller'].includes(result.code)) {
      onError(new Error(`data api ${result.code} for ${app.slug}/${def.name}: ${result.message}`));
    }
    if (!result.ok && result.code === 'denied') outcome.denied = true;
    return present(target.op, target.collection, args, result);
  }

  async function callTool(app: PreparedApp, tool: PreparedTool, args: Args, caller: Caller): Promise<CallToolResult> {
    const started = now();
    let result: CallToolResult;
    const outcome: { denied?: true } = {};
    try {
      result = await execute(app, tool, args, caller, outcome);
    } catch (e) {
      onError(e as Error);
      result = toolError(INTERNAL_FAILURE);
    }
    meter({
      type: 'mcp_call',
      app: app.slug,
      sub: caller.claims.sub,
      client: caller.claims.azp,
      tool: tool.def.name,
      ms: Math.round(now() - started),
      ok: !result.isError,
      ...outcome,
      args: argsSummary(args),
    });
    return result;
  }

  function prepare(slug: string, entry: AppRegistryEntry): PreparedApp {
    const urls = appUrls(config.publicBaseUrl, entry.handle, slug);
    const version = createHash('sha256').update(JSON.stringify(entry.schema)).digest('hex').slice(0, 12);
    // The SDK would reject invalid arguments before callTool runs, so such calls would escape the
    // rate limit and metering. It gets a pass-through validator and callTool validates instead.
    const tools: PreparedTool[] = buildTools(entry.schema).map((def) => {
      const strict = fromJsonSchema<Args>(def.inputSchema);
      return { def, strict, advertised: { '~standard': { ...strict['~standard'], validate: (value) => ({ value: value as Args }) } } };
    });
    const instructions =
      `Tools for the ${slug} app on Kelay. Every call runs as the signed-in user, with that user's permissions in this app. ` +
      `A call the user isn't allowed to make returns a short explanation instead of data.`;
    const prepared: PreparedApp = {
      slug,
      entry,
      urls,
      version,
      card: buildAgentCard({ schema: entry.schema, urls, version, oauth }),
      mcp: createMcpHandler(
        (ctx) => {
          const caller = ctx.authInfo?.extra?.caller as Caller | undefined;
          if (!caller) throw new Error('MCP request reached the server without a verified caller');
          const server = new McpServer({ name: slug, version }, { instructions });
          for (const tool of tools) {
            const { def } = tool;
            server.registerTool(
              def.name,
              { title: def.title, description: def.description, inputSchema: tool.advertised, annotations: def.annotations },
              (args) => callTool(prepared, tool, args, caller),
            );
          }
          return server;
        },
        { legacy: 'reject', onerror: onError },
      ),
    };
    return prepared;
  }

  // Keyed by the entry object: the registry hands out the same one until it reads the app again,
  // and a redeployed app (new schema, new tools) arrives as a new one.
  const preparedApps = new WeakMap<AppRegistryEntry, PreparedApp>();

  const resolve = async (c: Context): Promise<PreparedApp | undefined> => {
    const slug = c.req.param('app') ?? '';
    const entry = await deps.registry.get(slug, 'prod');
    if (!entry || entry.handle !== c.req.param('handle')) return undefined;
    let app = preparedApps.get(entry);
    if (!app) {
      app = prepare(slug, entry);
      preparedApps.set(entry, app);
    }
    return app;
  };
  const fail = (c: Context, code: ErrorCode, message: string, headers?: Record<string, string>) =>
    c.json(errorBody(code, message), HTTP_STATUS[code] as ContentfulStatusCode, headers);
  const unknownApp = (c: Context) => fail(c, 'unknown_app', 'No such app at this address.');

  const http = new Hono();

  http.get('/healthz', (c) => c.json({ ok: true }));

  http.use('/.well-known/oauth-protected-resource/*', cors({ origin: '*', allowMethods: ['GET'] }));
  http.get('/.well-known/oauth-protected-resource/:handle/:app/mcp', async (c) => {
    const app = await resolve(c);
    return app ? c.json(protectedResourceMetadata(app.urls, config.issuer, app.slug)) : unknownApp(c);
  });

  http.use('/:handle/:app/.well-known/agent-card.json', cors({ origin: '*', allowMethods: ['GET'] }), etag());
  http.get('/:handle/:app/.well-known/agent-card.json', async (c) => {
    const app = await resolve(c);
    if (!app) return unknownApp(c);
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(app.card);
  });

  http.post('/:handle/:app/mcp', async (c) => {
    const app = await resolve(c);
    if (!app) return unknownApp(c);
    const auth = await authenticate(c.req.header('authorization'), {
      jwks,
      issuer: config.issuer,
      resource: app.urls.resource,
      app: app.slug,
    });
    if (!auth.ok) {
      return fail(c, 'unauthenticated', auth.message, { 'WWW-Authenticate': challengeHeader(app.urls.resourceMetadata, auth) });
    }

    // Tool calls are limited inside the tool, so the assistant reads the limit as a tool result;
    // every other request is limited here. The body is read from a clone so the SDK can still read
    // the original when it is not valid JSON and answer with its own parse error.
    const body = await readRequestBody(c.req.raw.clone(), DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (body.tooLarge) return c.json(errorBody('invalid_request', 'Request body is too large.'), 413);
    let message: unknown;
    try {
      message = JSON.parse(body.text);
    } catch {
      message = undefined;
    }
    if (methodOf(message) !== 'tools/call') {
      const verdict = limiter.take(rateKeys(app.slug, auth));
      if (!verdict.ok) {
        return fail(c, 'rate_limited', `Rate limit reached (${ratePerMin} requests per minute).`, {
          'Retry-After': String(verdict.retryAfterSeconds),
        });
      }
    }

    const authInfo: AuthInfo = {
      token: auth.token,
      clientId: auth.claims.azp,
      scopes: auth.scopes,
      expiresAt: auth.claims.exp,
      resource: new URL(app.urls.resource),
      resourceMetadataUrl: app.urls.resourceMetadata,
      extra: { caller: auth },
    };
    return app.mcp.fetch(c.req.raw, { authInfo, ...(message === undefined ? {} : { parsedBody: message }) });
  });
  http.all('/:handle/:app/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));

  http.post('/:handle/:app/a2a', async (c) => {
    const app = await resolve(c);
    if (!app) return unknownApp(c);
    const request: unknown = await c.req.json().catch(() => undefined);
    const id = typeof request === 'object' && request !== null ? ((request as { id?: unknown }).id ?? null) : null;
    return c.json({
      jsonrpc: '2.0',
      id,
      error: { code: A2A_UNSUPPORTED_OPERATION, message: `A2A messaging is not available yet. Connect over MCP at ${app.urls.resource}.` },
    });
  });

  http.notFound((c) => fail(c, 'not_found', 'Not found.'));
  // Reached when the registry cannot say whether the app exists; "no such app" would be a wrong answer.
  http.onError((error, c) => {
    onError(error);
    return fail(c, 'internal', INTERNAL_FAILURE);
  });

  return http;
}
