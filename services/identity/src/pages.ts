// Server-rendered sign-in and consent pages. Forms post here; each handler forwards to the matching
// better-auth endpoint and turns its `{ redirect, url }` answer into a browser redirect.
import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { AppMemberRow } from '@kelay/contracts';
import type { AppResource, AppResources } from './apps.ts';
import { SOCIAL_PROVIDERS, type KelayAuth, type SocialProvider } from './auth.ts';
import type { ConsentRecorder } from './consents.ts';
import { mayUseApp, type MemberStore } from './members.ts';

export interface PageDeps {
  auth: KelayAuth;
  issuer: string;
  secret: string;
  apps: AppResources;
  members: MemberStore;
  emailPassword: boolean;
  social: SocialProvider[];
  /** Where granted consents are recorded. Without it, consents live in Kelay ID only. */
  consents?: ConsentRecorder;
  /** The header better-auth reads the client IP from, when it is not x-forwarded-for. */
  clientIpHeader?: string;
}

type Markup = HtmlEscapedString | Promise<HtmlEscapedString>;

const STYLE = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
  body { margin: 0; padding: 2rem 1rem; }
  main { max-width: 28rem; margin: 0 auto; }
  label { display: block; margin-top: .75rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; }
  button { margin-top: 1rem; margin-right: .5rem; padding: .5rem 1rem; font: inherit; cursor: pointer; }
  :focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
  [role=alert] { padding: .75rem; border: 2px solid currentColor; }
  dt { font-weight: 600; }
  dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
  section { margin-top: 2rem; }
`;

const layout = (title: string, body: Markup) => html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · Kelay ID</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      ${body}
    </main>
  </body>
</html>`;

const alert = (message: string | undefined) => (message ? html`<p role="alert">${message}</p>` : '');

const field = (form: Record<string, unknown>, name: string): string => {
  const value = form[name];
  return typeof value === 'string' ? value : '';
};

/** The signed authorization query better-auth appends to the login and consent page URLs. */
const signedQueryOf = (url: string): string => {
  const search = new URL(url).search.slice(1);
  return new URLSearchParams(search).has('sig') ? search : '';
};

function page(c: Context, status: number, title: string, body: Markup) {
  return c.html(layout(title, body), status as ContentfulStatusCode);
}

function messagePage(c: Context, status: number, title: string, message: string) {
  return page(c, status, title, html`<p>${message}</p>`);
}

// Origin, referer and sec-fetch-site keep better-auth's origin and CSRF checks applied to the
// browser's form post. sec-fetch-mode is dropped so the OAuth hooks answer with JSON, not a redirect.
const FORWARDED_HEADERS = ['cookie', 'origin', 'referer', 'user-agent', 'x-forwarded-for', 'sec-fetch-site'];

function callAuth(deps: PageDeps, path: string, body: Record<string, unknown>, from: Request): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json' });
  for (const name of deps.clientIpHeader ? [...FORWARDED_HEADERS, deps.clientIpHeader] : FORWARDED_HEADERS) {
    const value = from.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return deps.auth.handler(
    new Request(`${deps.issuer}/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  );
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error_description?: string; message?: string };
  return body.error_description ?? body.message ?? `Request failed (${res.status})`;
}

/** Sends the browser where better-auth pointed, carrying over the cookies it set. */
async function continueTo(res: Response, fallback: string): Promise<Response> {
  let location = res.headers.get('location');
  if (!location) {
    const body = (await res.json().catch(() => null)) as { redirect?: boolean; url?: unknown } | null;
    location = body?.redirect === true && typeof body.url === 'string' ? body.url : fallback;
  }
  const headers = new Headers({ location });
  for (const cookie of res.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function loginBody(deps: PageDeps, oauthQuery: string, error?: string) {
  const hidden = html`<input type="hidden" name="oauth_query" value="${oauthQuery}" />`;
  const email = deps.emailPassword
    ? html`<section aria-labelledby="sign-in-heading">
          <h2 id="sign-in-heading">Sign in</h2>
          <form method="post" action="/login">
            <input type="hidden" name="intent" value="sign-in" />${hidden}
            <label for="sign-in-email">Email</label>
            <input id="sign-in-email" name="email" type="email" autocomplete="email" required />
            <label for="sign-in-password">Password</label>
            <input id="sign-in-password" name="password" type="password" autocomplete="current-password" required />
            <button type="submit">Sign in</button>
          </form>
        </section>
        <section aria-labelledby="sign-up-heading">
          <h2 id="sign-up-heading">Create an account</h2>
          <form method="post" action="/login">
            <input type="hidden" name="intent" value="sign-up" />${hidden}
            <label for="sign-up-name">Name</label>
            <input id="sign-up-name" name="name" type="text" autocomplete="name" required />
            <label for="sign-up-email">Email</label>
            <input id="sign-up-email" name="email" type="email" autocomplete="email" required />
            <label for="sign-up-password">Password</label>
            <input id="sign-up-password" name="password" type="password" autocomplete="new-password" minlength="8" required />
            <button type="submit">Create account</button>
          </form>
        </section>`
    : '';
  const social = deps.social.length
    ? html`<section aria-labelledby="social-heading">
        <h2 id="social-heading">Continue with</h2>
        ${deps.social.map(
          (provider) => html`<form method="post" action="/login/social">
            <input type="hidden" name="provider" value="${provider}" />${hidden}
            <button type="submit">Continue with ${SOCIAL_PROVIDERS[provider]}</button>
          </form>`,
        )}
      </section>`
    : '';
  return html`${alert(error)}${email}${social}`;
}

interface ConsentView {
  userId: string;
  email: string;
  clientId: string;
  clientName: string;
  target: AppResource;
  member: AppMemberRow | undefined;
  scopes: string[];
}

async function loadConsent(deps: PageDeps, c: Context, oauthQuery: string): Promise<ConsentView | Response> {
  if (!oauthQuery || !(await verifyOAuthQueryParams(oauthQuery, deps.secret))) {
    return messagePage(c, 400, 'Request expired', 'This request expired or was changed. Start connecting again from your assistant.');
  }
  const headers = c.req.raw.headers;
  const session = await deps.auth.api.getSession({ headers });
  if (!session) return c.redirect(`/login?${oauthQuery}`, 303);
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get('client_id');
  const target = deps.apps.single(params.getAll('resource'));
  if (!clientId || !target) {
    return messagePage(c, 400, 'Unknown app', 'The assistant asked for an app that Kelay does not know.');
  }
  const client = await deps.auth.api.getOAuthClientPublic({ query: { client_id: clientId }, headers }).catch(() => null);
  if (!client) return messagePage(c, 400, 'Unknown assistant', 'Kelay could not identify this assistant.');
  return {
    userId: session.user.id,
    email: session.user.email,
    clientId,
    clientName: client.client_name ?? new URL(clientId).host,
    target,
    member: await deps.members.find(target.app, session.user.id),
    scopes: (params.get('scope') ?? '').split(' ').filter(Boolean),
  };
}

function consentBody(view: ConsentView, oauthQuery: string) {
  const { target, member, clientName } = view;
  const appName = `${target.handle}/${target.app}`;
  const allowed = mayUseApp(member);
  const refusal =
    member?.status === 'banned'
      ? `Your access to ${appName} is suspended, so ${clientName} cannot use it as you.`
      : member?.status === 'unconfirmed'
        ? `Your membership of ${appName} is not confirmed yet, so ${clientName} cannot use it as you.`
        : `You are not a member of ${appName}, so ${clientName} cannot use it as you.`;
  return html`<p><strong>${clientName}</strong> wants to use <strong>${appName}</strong> as you.</p>
    ${allowed ? '' : alert(refusal)}
    <dl>
      <dt>Assistant</dt>
      <dd>${clientName} (identified by ${view.clientId})</dd>
      <dt>App</dt>
      <dd>${appName}</dd>
      <dt>Signed in as</dt>
      <dd>${view.email}</dd>
      ${allowed ? html`<dt>Your role</dt><dd>${member.role}, ${member.plan} plan</dd>` : ''}
    </dl>
    ${allowed
      ? html`<h2>If you allow it, ${clientName} can</h2>
          <ul>
            <li>use ${appName}'s tools as you, with your role's permissions;</li>
            ${view.scopes.includes('offline_access') ? html`<li>stay connected until you revoke access.</li>` : ''}
          </ul>
          <p>This covers ${appName} only. Other apps ask you separately.</p>`
      : ''}
    <form method="post" action="/consent">
      <input type="hidden" name="oauth_query" value="${oauthQuery}" />
      ${allowed ? html`<button type="submit" name="accept" value="yes">Allow</button>` : ''}
      <button type="submit" name="accept" value="no">${allowed ? 'Deny' : `Back to ${clientName}`}</button>
    </form>`;
}

export function pageRoutes(deps: PageDeps): Hono {
  const r = new Hono();

  r.get('/', async (c) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    return page(
      c,
      200,
      'Kelay ID',
      session
        ? html`<p>Signed in as ${session.user.email}.</p>
            <form method="post" action="/logout"><button type="submit">Sign out</button></form>`
        : html`<p><a href="/login">Sign in</a></p>`,
    );
  });

  r.get('/login', (c) => page(c, 200, 'Sign in to Kelay', loginBody(deps, signedQueryOf(c.req.url))));

  r.post('/login', async (c) => {
    const form = await c.req.parseBody();
    const oauthQuery = field(form, 'oauth_query');
    if (!deps.emailPassword) return messagePage(c, 404, 'Not available', 'Email sign-in is turned off.');
    const signUp = field(form, 'intent') === 'sign-up';
    const credentials = { email: field(form, 'email'), password: field(form, 'password') };
    const res = await callAuth(
      deps,
      signUp ? '/sign-up/email' : '/sign-in/email',
      {
        ...credentials,
        ...(signUp ? { name: field(form, 'name') } : {}),
        ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
      },
      c.req.raw,
    );
    if (!res.ok) return page(c, res.status, 'Sign in to Kelay', loginBody(deps, oauthQuery, await errorMessage(res)));
    return continueTo(res, '/');
  });

  r.post('/login/social', async (c) => {
    const form = await c.req.parseBody();
    const provider = field(form, 'provider');
    if (!deps.social.includes(provider as SocialProvider)) {
      return messagePage(c, 400, 'Unknown provider', 'That sign-in provider is not enabled.');
    }
    const oauthQuery = field(form, 'oauth_query');
    const res = await callAuth(
      deps,
      '/sign-in/social',
      { provider, callbackURL: `${deps.issuer}/`, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) },
      c.req.raw,
    );
    if (!res.ok) return messagePage(c, res.status, 'Sign-in failed', await errorMessage(res));
    return continueTo(res, '/login');
  });

  r.post('/logout', async (c) => continueTo(await callAuth(deps, '/sign-out', {}, c.req.raw), '/'));

  r.get('/consent', async (c) => {
    const oauthQuery = signedQueryOf(c.req.url);
    const view = await loadConsent(deps, c, oauthQuery);
    if (view instanceof Response) return view;
    return page(c, 200, `Connect ${view.clientName}`, consentBody(view, oauthQuery));
  });

  r.post('/consent', async (c) => {
    const form = await c.req.parseBody();
    const oauthQuery = field(form, 'oauth_query');
    const view = await loadConsent(deps, c, oauthQuery);
    if (view instanceof Response) return view;
    const accept = field(form, 'accept') === 'yes' && mayUseApp(view.member);
    // Recorded before Kelay ID stores its own consent: if the control API cannot take it, nothing is
    // granted. The other order could leave an assistant connected that no one can see or revoke.
    if (accept && deps.consents) {
      try {
        await deps.consents.record({
          userId: view.userId,
          app: view.target.app,
          clientId: view.clientId,
          clientName: view.clientName,
          scopes: view.scopes,
        });
      } catch (e) {
        console.error(JSON.stringify({ type: 'consent_record_failed', app: view.target.app, client: view.clientId, message: (e as Error).message }));
        return messagePage(c, 502, 'Could not connect', `Kelay could not save this connection, so ${view.clientName} was not connected. Go back and choose Allow again.`);
      }
    }
    const res = await callAuth(deps, '/oauth2/consent', { accept, oauth_query: oauthQuery }, c.req.raw);
    if (!res.ok) return messagePage(c, res.status, 'Consent failed', await errorMessage(res));
    return continueTo(res, '/');
  });

  return r;
}
