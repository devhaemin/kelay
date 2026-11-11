import { builderProxy } from '@/lib/api/builder-server';

export async function GET(_request: Request, { params }: { params: Promise<{ app: string }> }) {
  return builderProxy(`/v1/workspaces/${encodeURIComponent((await params).app)}`);
}
