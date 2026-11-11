'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { AppDetail, WorkspaceTab } from '@/lib/api/types';
import { useUiPrefs } from '../providers';
import { ShareAppModal } from '../share-modals';
import { AppIcon, Icon, StatusPill } from '../ui';
import { TABS } from './tab-registry';

export interface ShellApp extends Pick<AppDetail, 'id' | 'name' | 'emoji' | 'color' | 'status'> {
  /** Present once the app exists; the Share button needs it. */
  detail: AppDetail | null;
}

export function WorkspaceShell({
  app,
  tab,
  pendingProposals,
  tabsDisabled = false,
  chat,
  overlay,
  children,
}: {
  app: ShellApp;
  tab: WorkspaceTab;
  pendingProposals: number;
  /** While the first build runs there is nothing behind the other tabs yet. */
  tabsDisabled?: boolean;
  chat: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const { chatOpen, setChatOpen } = useUiPrefs();
  const [sharing, setSharing] = useState(false);

  return (
    <>
      <div className={clsx('ws', !chatOpen && 'chat-collapsed')}>
        <section className="ws-main">
          <div className="ws-head">
            <Link href="/apps" className="back" title="My Apps" aria-label="Back to My Apps"><Icon name="left" size={18} /></Link>
            <AppIcon emoji={app.emoji} color={app.color} size={30} />
            <h1 className="ws-title" style={{ margin: 0 }}>{app.name} <StatusPill status={app.status} /></h1>
            <div style={{ flex: 1 }} />
            <button type="button" className="btn sm" disabled={!app.detail} onClick={() => setSharing(true)}><Icon name="share" size={14} /> Share</button>
            {app.detail ? (
              <Link className="btn sm primary" href={`/app/${app.id}/${tab}/ship`}><Icon name="rocket" size={14} /> Deploy</Link>
            ) : (
              <button type="button" className="btn sm primary" disabled><Icon name="rocket" size={14} /> Deploy</button>
            )}
            <button
              type="button"
              className="btn sm ghost"
              title="Toggle agent panel"
              aria-label="Toggle agent panel"
              aria-pressed={chatOpen}
              onClick={() => setChatOpen(!chatOpen)}
            >
              <Icon name="panel" />
            </button>
          </div>
          <nav className="tabs" aria-label="Workspace">
            {TABS.map((t) => {
              const badge = t.key === 'feedback' && pendingProposals > 0 ? <span className="count" aria-label={`${pendingProposals} proposals waiting`}>{pendingProposals}</span> : null;
              if (tabsDisabled && t.key !== tab) {
                return <span key={t.key} className="disabled" aria-disabled="true"><Icon name={t.icon} size={15} /> {t.label}</span>;
              }
              return (
                <Link key={t.key} href={`/app/${app.id}/${t.key}`} className={clsx(tab === t.key && 'on')} aria-current={tab === t.key ? 'page' : undefined}>
                  <Icon name={t.icon} size={15} /> {t.label}{badge && <> {badge}</>}
                </Link>
              );
            })}
          </nav>
          <div className="ws-body">{children}</div>
        </section>
        {chatOpen && chat}
      </div>
      {app.detail && <ShareAppModal open={sharing} onOpenChange={setSharing} app={app.detail} />}
      {overlay}
    </>
  );
}

export function TabPlaceholder({ label }: { label: string }) {
  return (
    <div className="card">
      <div className="empty">
        <b>{label}</b>
        <div>This tab is being built. It will show up here as soon as it lands.</div>
      </div>
    </div>
  );
}
