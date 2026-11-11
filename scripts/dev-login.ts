// Local sign-in for the console. The console reads the builder's Kelay ID token from the httpOnly
// `kelay_token` cookie and has no sign-in flow of its own yet, so this signs the seeded builder in
// at Kelay ID and asks for a `kelay-console` token.
//
//   pnpm dev:login           prints the token (paste it at <console>/signin)
//   pnpm dev:login --serve   serves a page that sets the cookie and redirects to the console;
//                            `pnpm dev:up` runs this. Cookies ignore the port, so a cookie set by
//                            localhost:4005 is sent to the console on localhost:3000.
import { createServer } from 'node:http';
import { loadConfig, portOf } from './lib/config.ts';
import { BUILDER, CONSOLE_APP, PASSWORD } from './lib/data.ts';
import { KelayIdSession } from './lib/session.ts';

if (process.env.NODE_ENV === 'production') throw new Error('dev-login is for local development only');

const cfg = loadConfig();
const TOKEN_COOKIE = 'kelay_token';
/** Kelay ID signs app tokens for 15 minutes. */
const TOKEN_TTL_SECONDS = 15 * 60;

async function builderToken(): Promise<string> {
  const session = new KelayIdSession(cfg.issuer);
  await session.signIn(BUILDER.email, PASSWORD);
  return session.appToken(CONSOLE_APP);
}

if (process.argv.includes('--serve')) {
  const server = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    try {
      const token = await builderToken();
      res
        .writeHead(302, {
          'set-cookie': `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_TTL_SECONDS}`,
          'cache-control': 'no-store',
          location: `${cfg.consoleUrl}/`,
        })
        .end();
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`Could not sign the builder in at ${cfg.issuer}: ${(e as Error).message}\n`);
    }
  });
  // Anyone who can reach this port becomes the builder, so it listens on loopback only.
  server.listen(portOf(cfg.devLoginUrl), 'localhost', () => console.log(`dev sign-in on ${cfg.devLoginUrl}/`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
} else {
  const token = await builderToken();
  console.error(`Builder token for ${BUILDER.email} (valid 15 minutes). Paste it at ${cfg.consoleUrl}/signin,`);
  console.error(`or open ${cfg.devLoginUrl}/ while \`pnpm dev:up\` is running to have the cookie set for you.\n`);
  console.log(token);
}
