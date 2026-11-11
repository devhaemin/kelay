import { builderProxy } from '@/lib/api/builder-server';

/** Builder chat: `{ text, context? }` starts an agent turn; its progress arrives on the events stream. */
export async function POST(request: Request, { params }: { params: Promise<{ app: string }> }) {
  return builderProxy(`/v1/workspaces/${encodeURIComponent((await params).app)}/messages`, { method: 'POST', body: await request.text() });
}
