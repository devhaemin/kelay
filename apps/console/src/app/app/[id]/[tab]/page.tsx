import { Workspace } from '@/components/workspace/workspace';

export default async function WorkspacePage({ params }: { params: Promise<{ id: string; tab: string }> }) {
  const { id, tab } = await params;
  return <Workspace id={id} tab={tab} />;
}
