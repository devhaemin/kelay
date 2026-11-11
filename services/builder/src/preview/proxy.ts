// The preview proxy of docs/infrastructure.md §4.1: it maps a dev preview URL to the `next dev` of the
// app's workspace, over HTTP and WebSocket (HMR), for the builder who owns the app and nobody else.
//
// Two address forms, both always on:
//   /preview/<app>/…        on the Builder's own host. `next dev` serves its scripts and its HMR socket
//                           from the root (/_next/…), so a request that names no app goes to the app of
//                           the browser's current preview (a cookie set when the preview was opened).
//   <app>.<preview domain>  one host per app, when a preview domain is configured.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { SLUG, type ErrorCode } from '@kelay/contracts';
import { createProxyServer } from 'http-proxy-3';
import type { Logger } from 'pino';
import { CURRENT_APP_COOKIE, PreviewSessions, SESSION_TTL_SECONDS, TICKET_PARAM, parseCookies, sessionCookie, withoutPreviewCookies, type PreviewGrant } from './session.ts';

const PATH_PREFIX = '/preview/';
/** Paths of the Builder itself; a request for them is never sent to an app. */
const OWN_PATHS = /^\/(v1|healthz|runtime)(\/|$|\?)/;
const STATUS: Partial<Record<ErrorCode, number>> = { unauthenticated: 401, denied: 403, not_found: 404, conflict: 409, internal: 502 };

export interface PreviewProxyOptions {
  sessions: PreviewSessions;
  /** Where the app's dev server listens (e.g. http://10.0.3.17:3000), or null while its workspace is not running. */
  target(app: string): string | null;
  /**
   * Checks a Kelay ID token sent as `authorization: Bearer`, for callers that are not a browser frame.
   * It answers the grant when the token's builder owns the app.
   */
  bearer?(token: string, app: string): Promise<PreviewGrant | null>;
  /** `<app>.<domain>` is the preview of `<app>`, e.g. `preview.kelay.dev`. */
  domain?: string;
  logger: Logger;
}

interface Match {
  app: string;
  /** The path and query the dev server gets. */
  path: string;
  /** Prefix the browser sees in front of the app's paths: `/preview/<app>` or ''. */
  prefix: string;
}

export class PreviewProxy {
  private readonly proxy = createProxyServer({ ws: true, proxyTimeout: 120_000 });
  private readonly matches = new WeakMap<IncomingMessage, Match>();

  constructor(private readonly opts: PreviewProxyOptions) {
    this.proxy.on('error', (err, req, res) => {
      opts.logger.warn({ type: 'preview_upstream', app: this.matches.get(req)?.app, err: err.message }, 'the dev preview did not answer');
      if ('writeHead' in res) {
        if (!res.headersSent) this.fail(res, 'internal', 'The dev preview did not answer. It may still be starting.');
        else res.end();
      } else res.destroy();
    });
    // The dev server redirects within itself; under /preview/<app> the browser needs the prefix back.
    this.proxy.on('proxyRes', (proxyRes, req) => {
      const prefix = this.matches.get(req)?.prefix;
      const location = proxyRes.headers.location;
      if (prefix && location?.startsWith('/') && !location.startsWith('//')) proxyRes.headers.location = `${prefix}${location}`;
    });
  }

  /** Which app a request is for, or null when it is not a preview request. */
  private match(req: IncomingMessage): Match | null {
    const url = req.url ?? '/';
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const domain = this.opts.domain?.toLowerCase();
    if (domain && host.endsWith(`.${domain}`)) {
      const app = host.slice(0, -domain.length - 1);
      return SLUG.test(app) ? { app, path: url, prefix: '' } : null;
    }
    if (url.startsWith(PATH_PREFIX)) {
      const rest = url.slice(PATH_PREFIX.length);
      const end = rest.search(/[/?]/);
      const app = end === -1 ? rest : rest.slice(0, end);
      if (!SLUG.test(app)) return null;
      const path = end === -1 ? '/' : rest.slice(end);
      return { app, path: path.startsWith('/') ? path : `/${path}`, prefix: `${PATH_PREFIX}${app}` };
    }
    if (OWN_PATHS.test(url)) return null;
    const current = parseCookies(req.headers.cookie).get(CURRENT_APP_COOKIE);
    return current && SLUG.test(current) ? { app: current, path: url, prefix: '' } : null;
  }

  private fail(res: ServerResponse, code: ErrorCode, message: string, headers: Record<string, string> = {}): void {
    res.writeHead(STATUS[code] ?? 500, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify({ error: { code, message } }));
  }

  private async grant(req: IncomingMessage, app: string): Promise<PreviewGrant | null> {
    const session = await this.opts.sessions.verify('session', app, parseCookies(req.headers.cookie).get(sessionCookie(app)));
    if (session) return session;
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    return bearer && this.opts.bearer ? this.opts.bearer(bearer, app) : null;
  }

  /**
   * What the dev server gets: the request as if a browser on its own machine had asked it directly.
   * `next dev` serves its scripts and its HMR socket to localhost only, and checks a form post's origin
   * against the host. The builder's token, the proxy's cookies and x-kelay-* headers are not for
   * agent-written code.
   */
  private rewrite(req: IncomingMessage, match: Match, target: string): void {
    const local = `localhost:${new URL(target).port || '80'}`;
    req.url = match.path;
    req.headers.host = local;
    if (req.headers.origin) req.headers.origin = `http://${local}`;
    if (req.headers.referer) {
      const referer = URL.parse(req.headers.referer);
      req.headers.referer = referer ? `http://${local}${referer.pathname.startsWith(match.prefix) ? referer.pathname.slice(match.prefix.length) || '/' : referer.pathname}${referer.search}` : `http://${local}/`;
    }
    delete req.headers.authorization;
    for (const name of Object.keys(req.headers)) if (name.startsWith('x-kelay-')) delete req.headers[name];
    const cookie = withoutPreviewCookies(req.headers.cookie);
    if (cookie) req.headers.cookie = cookie;
    else delete req.headers.cookie;
  }

  /** Handles the request when it is for a preview. False: it is the Builder API's. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const match = this.match(req);
    if (!match) return false;
    this.matches.set(req, match);
    void this.serve(req, res, match).catch((e: Error) => {
      this.opts.logger.error({ type: 'preview_failed', app: match.app, err: e.message }, 'preview request failed');
      if (!res.headersSent) this.fail(res, 'internal', 'The preview proxy failed.');
      else res.end();
    });
    return true;
  }

  private async serve(req: IncomingMessage, res: ServerResponse, match: Match): Promise<void> {
    const { app } = match;
    // A ticket in the URL becomes a session cookie, and the browser comes back without the ticket.
    const url = new URL(req.url ?? '/', 'http://preview.invalid');
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket !== null) {
      const grant = await this.opts.sessions.verify('ticket', app, ticket);
      // A frame that is reloaded sends its first address again; by then the ticket is old and the session is what counts.
      if (!grant && !(await this.grant(req, app))) return this.fail(res, 'unauthenticated', 'This preview link has expired. Open the app in the console again.');
      url.searchParams.delete(TICKET_PARAM);
      const secure = req.headers['x-forwarded-proto'] === 'https' || 'encrypted' in req.socket ? '; Secure' : '';
      const attributes = `Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
      const cookies = [...(grant ? [`${sessionCookie(app)}=${await this.opts.sessions.session(grant)}; ${attributes}`] : []), ...(match.prefix ? [`${CURRENT_APP_COOKIE}=${app}; ${attributes}`] : [])];
      res.writeHead(302, { location: `${url.pathname}${url.search}`, ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end();
      return;
    }

    if (!(await this.grant(req, app))) return this.fail(res, 'unauthenticated', 'Open this preview from the console: only the builder of the app can see it.');
    const target = this.opts.target(app);
    if (!target) return this.fail(res, 'conflict', `The dev preview of ${app} is not running. Send the Builder a message to start it.`, { 'retry-after': '5' });
    this.rewrite(req, match, target);
    this.proxy.web(req, res, { target });
  }

  /** Handles a WebSocket upgrade when it is for a preview (the HMR socket). False: nothing here takes it. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const match = this.match(req);
    if (!match) return false;
    this.matches.set(req, match);
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      socket.destroy();
    };
    void (async () => {
      if (!(await this.grant(req, match.app))) return refuse('401 Unauthorized');
      const target = this.opts.target(match.app);
      if (!target) return refuse('409 Conflict');
      this.rewrite(req, match, target);
      this.proxy.ws(req, socket, head, { target });
    })().catch((e: Error) => {
      this.opts.logger.error({ type: 'preview_failed', app: match.app, err: e.message }, 'preview upgrade failed');
      refuse('502 Bad Gateway');
    });
    return true;
  }

  close(): void {
    this.proxy.close();
  }
}
