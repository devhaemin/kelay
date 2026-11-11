import { notFound } from 'next/navigation';
import { createAppAction, deployAction, publishAction, sendBuilderMessageAction } from '@/app/actions';
import { isApiError } from '@/lib/api/errors';
import { getConsoleApi } from '@/lib/api/server';
import type { AppDetail, AppSummary, ConsoleApi } from '@/lib/api/types';
import { DEFAULT_PROMPT } from '@/lib/build';
import { countPolicies } from '@/lib/policy';
import { ChatPanel } from './chat-panel';
import { LiveNewAppWorkspace, NewAppWorkspace } from './screen/new-app-workspace';
import { ShipModal } from './screen/ship-modal';
import { loadTabData } from './tab-data';
import { TABS, isTab, loadTab } from './tab-registry';
import { TabPlaceholder, WorkspaceShell } from './workspace-shell';

async function orNotFound<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (isApiError(e) && e.status === 404) notFound();
    throw e;
  }
}

/** The id the Home prompt builds under before the app exists. */
export const NEW_APP = 'new';

export interface WorkspaceParams {
  id: string;
  tab: string;
  ship?: boolean;
  prompt?: string | undefined;
  created?: string | undefined;
}

/** Server entry for `/app/:id/:tab` and `/app/:id/:tab/ship`. */
export async function Workspace({ id, tab, ship = false, prompt, created }: WorkspaceParams) {
  if (!isTab(tab)) notFound();
  const api = await getConsoleApi();

  if (id === NEW_APP) {
    if (tab !== 'screen' || ship) notFound();
    const app: AppSummary | null = created ? await orNotFound(api.getApp(created)) : null;
    const text = prompt?.trim() || DEFAULT_PROMPT;
    // With a Builder the workspace builds the app; in mock mode the page plays the steps itself.
    if (api.mode === 'http' && process.env.BUILDER_URL) {
      return <LiveNewAppWorkspace key={prompt ?? created ?? ''} prompt={text} created={app} session={app ? await api.getBuilderSession(app.id) : null} />;
    }
    return <NewAppWorkspace key={prompt ?? created ?? ''} prompt={text} created={app} onCreate={createAppAction} onDeploy={deployAction} />;
  }

  const app = await orNotFound(api.getApp(id));
  const [reports, session, Tab, tabData] = await Promise.all([api.listReports(id), api.getBuilderSession(id), loadTab(tab), loadTabData(api, app, tab)]);
  // An app with a workspace streams its chat from the Builder; the others keep the fetched thread.
  const thread = session ? [] : await api.getBuilderThread(id, tab);
  const meta = TABS.find((t) => t.key === tab)!;
  const pending = reports[0]?.proposals.filter((p) => p.state === 'pending').length ?? 0;

  return (
    <WorkspaceShell
      app={{ ...app, detail: app }}
      tab={tab}
      pendingProposals={pending}
      chat={<ChatPanel appName={app.name} context={meta.context} messages={thread} session={session} onSend={sendBuilderMessageAction.bind(null, id, tab)} />}
      overlay={ship ? await shipModal(api, app, tab) : null}
    >
      {Tab ? <Tab {...tabData} app={app} /> : <TabPlaceholder label={meta.label} />}
    </WorkspaceShell>
  );
}

async function shipModal(api: ConsoleApi, app: AppDetail, tab: string) {
  const [me, policy, qa] = await Promise.all([api.getMe(), api.getPolicy(app.id).catch(() => null), api.getQa(app.id)]);
  return (
    <ShipModal
      app={app}
      closeHref={`/app/${app.id}/${tab}`}
      team={me.team}
      ruleCount={policy ? countPolicies(policy.matrix) : null}
      checkCount={qa?.total ?? null}
      onPublish={publishAction.bind(null, app.id)}
    />
  );
}
