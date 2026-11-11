// Starts a sign-in: Kelay ID's login page, which comes back to /auth/callback.
import { loginUrl } from '@/lib/auth/kelay-id';
import { dataMode } from '@/lib/api/server';

export function GET(request: Request): Response {
  // Mock data has nothing to sign in to.
  return Response.redirect(dataMode() === 'mock' ? new URL('/', request.url) : loginUrl(), 307);
}
