import { builderProxy } from '@/lib/api/builder-server';

export const dynamic = 'force-dynamic';

/** The workspace's event stream (SSE), passed through. `Last-Event-ID` and `?after=` resume it. */
export async function GET(request: Request, { params }: { params: Promise<{ app: string }> }) {
  const lastEventId = request.headers.get('last-event-id');
  return builderProxy(`/v1/workspaces/${encodeURIComponent((await params).app)}/events${new URL(request.url).search}`, {
    headers: { accept: 'text/event-stream', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
    // Closing the browser's stream closes the one to the Builder.
    signal: request.signal,
  });
}
