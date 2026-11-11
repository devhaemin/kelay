import type { Metadata } from 'next';
import { allowGrantAction, rejectGrantAction, requestGrantAction } from '@/app/actions';
import { GraphView } from '@/components/graph/graph-view';
import { TopBar } from '@/components/top-bar';
import { getConsoleApi } from '@/lib/api/server';
import { withAgentLinks } from '@/lib/graph';

export const metadata: Metadata = { title: 'App Graph' };

/** `/graph` or `/graph/<app | link id>` to open with that node or connection selected. */
export default async function GraphPage({ params }: { params: Promise<{ focus?: string[] }> }) {
  const { focus } = await params;
  const api = await getConsoleApi();
  const [me, apps, grants, consents, overview] = await Promise.all([
    api.getMe(),
    api.listApps(),
    api.listGrants(),
    api.listConsents(),
    api.getGraphOverview(),
  ]);

  return (
    <>
      <TopBar active="graph" me={me} signedIn={api.mode === 'http'} />
      <GraphView
        apps={apps}
        grants={withAgentLinks(grants, consents, apps)}
        consents={consents}
        overview={overview}
        focus={focus?.[0] ? decodeURIComponent(focus[0]) : null}
        onAllow={allowGrantAction}
        onReject={rejectGrantAction}
        onRequest={requestGrantAction}
      />
    </>
  );
}
