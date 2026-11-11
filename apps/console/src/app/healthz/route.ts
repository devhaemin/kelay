// Load balancer health check. It answers without a session and without calling the control API.
export const dynamic = 'force-static';

export function GET(): Response {
  return Response.json({ ok: true, service: 'console' });
}
