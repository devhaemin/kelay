import 'server-only';
import type { ComponentType } from 'react';
import type { WorkspaceTab } from '@/lib/api/types';
import type { TabProps } from './tab-meta';

export { TABS, isTab, type TabProps } from './tab-meta';

// Tabs are built in parallel; a tab whose module is not in the tree yet renders a placeholder.
// Server-only: tab modules may be server components, so the glob must never reach a client bundle.
const modules = import.meta.glob<{ default: ComponentType<TabProps> }>('./tabs/*-tab.tsx');

export async function loadTab(key: WorkspaceTab): Promise<ComponentType<TabProps> | null> {
  const load = modules[`./tabs/${key}-tab.tsx`];
  return load ? (await load()).default : null;
}
