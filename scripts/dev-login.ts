// A shortcut past the login form for local development. The console signs builders in through
// Kelay ID (apps/console/src/lib/auth/kelay-id.ts); this signs the seeded builder in for you.
//
//   pnpm dev:login           prints a `kelay-console` token, for calling the Control API or the
//                            Builder by hand (`authorization: Bearer <token>`)
//   pnpm dev:login --serve   serves a page that signs the seeded builder in at Kelay ID, hands the
//                            session cookie to the browser and opens the console, which trades the
//                            session for its token as after any sign-in. `pnpm dev:up` runs this.
//                            Cookies ignore the port, so a cookie set by localhost:4005 is sent to
//                            Kelay ID on localhost:4001 and to the console on localhost:3000.
import { createServer } from 'node:http';
import { loadConfig, portOf } from './lib/config.ts';
import { BUILDER, CONSOLE_APP, PASSWORD } from './lib/data.ts';
import { KelayIdSession } from './lib/session.ts';

if (process.env.NODE_ENV === 'production') throw new Error('dev-login is for local development only');

const cfg = loadConfig();

/** Signs the seeded builder in and returns the `Set-Cookie` headers of Kelay ID's answer: the session. */
async function builderSession(): Promise<string[]> {
  const res = await fetch(`${cfg.issuer}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { origin: cfg.issuer, 'content-type': 'application/json' },
    body: JSON.stringify({ email: BUILDER.email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in as ${BUILDER.email} failed: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie();
}

if (process.argv.includes('--serve')) {
  const server = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    try {
      res.writeHead(302, { 'set-cookie': await builderSession(), 'cache-control': 'no-store', location: `${cfg.consoleUrl}/auth/callback` }).end();
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`Could not sign the builder in at ${cfg.issuer}: ${(e as Error).message}\n`);
    }
  });
  // Anyone who can reach this port becomes the builder, so it listens on loopback only.
  server.listen(portOf(cfg.devLoginUrl), 'localhost', () => console.log(`dev sign-in on ${cfg.devLoginUrl}/`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
} else {
  const session = new KelayIdSession(cfg.issuer);
  await session.signIn(BUILDER.email, PASSWORD);
  console.error(`Builder token for ${BUILDER.email} (valid 15 minutes), for calls to the Control API and the Builder.`);
  console.error(`To use the console, sign in at ${cfg.consoleUrl}, or open ${cfg.devLoginUrl}/ while \`pnpm dev:up\` is running.\n`);
  console.log(await session.appToken(CONSOLE_APP));
}
