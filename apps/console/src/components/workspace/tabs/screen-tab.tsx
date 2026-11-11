import { getConsoleApi } from '@/lib/api/server';
import type { TabProps } from '../tab-meta';
import { ScreenView } from '../screen/screen-view';

export default async function ScreenTab({ app }: TabProps) {
  const api = await getConsoleApi();
  const [preview, members, me] = await Promise.all([api.getPreview(app.id), api.listMembers(app.id), api.getMe()]);
  return <ScreenView app={app} preview={preview} members={members} team={me.team} />;
}
