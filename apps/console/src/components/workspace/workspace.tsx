import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { sendBuilderMessageAction } from '@/app/actions';
import { isApiError } from '@/lib/api/errors';
import { getConsoleApi } from '@/lib/api/server';
import type { AppDetail, ConsoleApi, WorkspaceTab } from '@/lib/api/types';
import { ChatPanel } from './chat-panel';
import { TABS, isTab, loadTab } from './tab-registry';
import { TabPlaceholder, WorkspaceShell } from './workspace-shell';

async function getAppOr404(api: ConsoleApi, id: string): Promise<AppDetail> {
  try {
    return await api.getApp(id);
  } catch (e) {
    if (isApiError(e) && e.status === 404) notFound();
    throw e;
  }
}

/** Server entry for `/app/:id/:tab` and `/app/:id/:tab/ship`. */
export async function Workspace({ id, tab, overlay }: { id: string; tab: string; overlay?: (app: AppDetail, tab: WorkspaceTab) => ReactNode }) {
  if (!isTab(tab)) notFound();
  const api = await getConsoleApi();
  const app = await getAppOr404(api, id);
  const [reports, thread, Tab] = await Promise.all([api.listReports(id), api.getBuilderThread(id, tab), loadTab(tab)]);
  const meta = TABS.find((t) => t.key === tab)!;
  const pending = reports[0]?.proposals.filter((p) => p.state === 'pending').length ?? 0;

  return (
    <WorkspaceShell
      app={{ ...app, detail: app }}
      tab={tab}
      pendingProposals={pending}
      chat={<ChatPanel appName={app.name} context={meta.context} messages={thread} onSend={sendBuilderMessageAction.bind(null, id, tab)} />}
      overlay={overlay?.(app, tab)}
    >
      {Tab ? <Tab app={app} /> : <TabPlaceholder label={meta.label} />}
    </WorkspaceShell>
  );
}
