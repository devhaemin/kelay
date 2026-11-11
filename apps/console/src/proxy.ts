// Keeps the builder's token fresh. Kelay ID signs it for 15 minutes; on any request that arrives with
// no token, or with one about to expire, the Kelay ID session in the browser's cookies is traded for
// a new one. The request goes on with the new token, and the response stores it.
import { NextResponse, type NextRequest } from 'next/server';
import { TOKEN_COOKIE, exchangeSession, needsRefresh, tokenCookieOptions, tokenExpiry } from '@/lib/auth/kelay-id';

export const config = {
  // Not the sign-in pages and routes themselves, the health check or build assets.
  matcher: ['/((?!_next/|healthz|signin|auth/|favicon.ico).*)'],
};

export async function proxy(request: NextRequest) {
  if (process.env.CONSOLE_DATA !== 'http') return NextResponse.next();
  const current = request.cookies.get(TOKEN_COOKIE)?.value;
  if (!needsRefresh(current)) return NextResponse.next();

  const exchange = await exchangeSession(request.headers.get('cookie'));
  if (exchange.ok) {
    request.cookies.set(TOKEN_COOKIE, exchange.token);
    const response = NextResponse.next({ request: { headers: request.headers } });
    response.cookies.set(TOKEN_COOKIE, exchange.token, tokenCookieOptions(exchange.expiresAt));
    return response;
  }
  // Kelay ID being away is no reason to drop a token that still works.
  if (exchange.reason === 'unavailable' && tokenExpiry(current) > Date.now()) return NextResponse.next();
  // Signed out, or no longer a builder: the page sends them to sign in instead of calling with a dead token.
  request.cookies.delete(TOKEN_COOKIE);
  const response = NextResponse.next({ request: { headers: request.headers } });
  if (current) response.cookies.delete(TOKEN_COOKIE);
  return response;
}
