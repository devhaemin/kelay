import { Workspace } from '@/components/workspace/workspace';

/** Deploy: the workspace tab with the ship modal on top, as `#/app/:id/:tab/ship` in the prototype. */
export default async function ShipPage({ params }: { params: Promise<{ id: string; tab: string }> }) {
  const { id, tab } = await params;
  return <Workspace id={id} tab={tab} ship />;
}
