import type { ComponentType } from 'react';
import type { IconName } from '@/components/icon-paths';
import type { AppDetail, WorkspaceTab } from '@/lib/api/types';

/** Every workspace tab module (`tabs/<key>-tab.tsx`) default-exports a component with these props. */
export interface TabProps {
  app: AppDetail;
}

export const TABS: readonly { key: WorkspaceTab; label: string; icon: IconName; context: string }[] = [
  { key: 'screen', label: 'Screen', icon: 'monitor', context: 'Screen · Board' },
  { key: 'access', label: 'Access', icon: 'shield', context: 'Access · tickets' },
  { key: 'qa', label: 'QA', icon: 'flask', context: 'QA' },
  { key: 'agent', label: 'Agent', icon: 'cpu', context: 'Agent' },
  { key: 'feedback', label: 'Feedback', icon: 'inbox', context: 'Feedback · Daily report' },
  { key: 'users', label: 'Users', icon: 'users', context: 'Users' },
  { key: 'monitoring', label: 'Monitoring', icon: 'chart', context: 'Monitoring' },
];

export const isTab = (v: string): v is WorkspaceTab => TABS.some((t) => t.key === v);

// Tabs are built in parallel; a tab whose module is not in the tree yet renders a placeholder.
const modules = import.meta.glob<{ default: ComponentType<TabProps> }>('./tabs/*-tab.tsx');

export async function loadTab(key: WorkspaceTab): Promise<ComponentType<TabProps> | null> {
  const load = modules[`./tabs/${key}-tab.tsx`];
  return load ? (await load()).default : null;
}
