import type { Metadata } from 'next';
import { AppsView } from '@/components/apps/apps-view';
import { TopBar } from '@/components/top-bar';
import { getConsoleApi } from '@/lib/api/server';

export const metadata: Metadata = { title: 'My Apps' };

export default async function AppsPage() {
  const api = await getConsoleApi();
  const [me, apps] = await Promise.all([api.getMe(), api.listApps()]);
  return (
    <>
      <TopBar active="apps" me={me} signedIn={api.mode === 'http'} />
      <AppsView me={me} apps={apps} now={Date.now()} />
    </>
  );
}
