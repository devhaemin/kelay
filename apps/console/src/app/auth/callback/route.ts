// Where Kelay ID sends the browser back after a sign-in. The browser arrives with Kelay ID's session
// cookie; the token it is traded for goes into an httpOnly cookie and never into a URL or a page.
import { NextResponse } from 'next/server';
import { TOKEN_COOKIE, consoleUrl, exchangeSession, tokenCookieOptions } from '@/lib/auth/kelay-id';

export async function GET(request: Request): Promise<Response> {
  const exchange = await exchangeSession(request.headers.get('cookie'));
  if (!exchange.ok) return NextResponse.redirect(`${consoleUrl()}/signin?error=${exchange.reason}`, { status: 303, headers: { 'cache-control': 'no-store' } });
  const response = NextResponse.redirect(`${consoleUrl()}/`, { status: 303, headers: { 'cache-control': 'no-store' } });
  response.cookies.set(TOKEN_COOKIE, exchange.token, tokenCookieOptions(exchange.expiresAt));
  return response;
}
