// Signs the builder out: ends the Kelay ID session and drops the console's token. Without the first,
// the next page load would trade the session for a new token and nothing would have happened.
import { NextResponse } from 'next/server';
import { TOKEN_COOKIE, consoleUrl, endSession } from '@/lib/auth/kelay-id';

export async function POST(request: Request): Promise<Response> {
  // A form on another site must not be able to sign a builder out.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(consoleUrl()).origin) return Response.json({ error: { code: 'denied', message: 'sign out from the console' } }, { status: 403 });
  await endSession(request.headers.get('cookie'));
  const response = NextResponse.redirect(`${consoleUrl()}/signin?signed_out=1`, { status: 303, headers: { 'cache-control': 'no-store' } });
  response.cookies.delete(TOKEN_COOKIE);
  return response;
}
