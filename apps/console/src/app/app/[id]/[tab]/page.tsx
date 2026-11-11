import { Workspace } from '@/components/workspace/workspace';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function WorkspacePage({ params, searchParams }: { params: Promise<{ id: string; tab: string }>; searchParams: SearchParams }) {
  const [{ id, tab }, query] = await Promise.all([params, searchParams]);
  return <Workspace id={id} tab={tab} prompt={first(query.prompt)} created={first(query.created)} />;
}
