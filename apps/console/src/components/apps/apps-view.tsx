'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { AppSummary, Builder } from '@/lib/api/types';
import { initials } from '@/lib/format';
import { AppCard, NewAppCard } from '../app-card';
import { ShareStoreModal } from '../share-modals';
import { Icon, Seg } from '../ui';

type Filter = 'all' | 'live' | 'draft';

export function AppsView({ me, apps, now }: { me: Builder; apps: AppSummary[]; now: number }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [sharing, setSharing] = useState(false);
  const q = query.trim().toLowerCase();
  const list = apps.filter(
    (a) => (filter === 'all' || a.status === filter) && (!q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)),
  );

  return (
    <main className="page">
      <div className="page-title">
        <div className="profile">
          <div className="avatar" aria-hidden="true">{initials(me.name)}</div>
          <div>
            <h1>{me.name}’s Apps</h1>
            <p>
              kelay.app/{me.handle} · {apps.length} apps{me.team ? ` · used by ${me.team}` : ''}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={() => setSharing(true)}><Icon name="share" size={14} /> Share store page</button>
          <Link href="/" className="btn primary"><Icon name="plus" size={14} /> New app</Link>
        </div>
      </div>
      <div className="toolbar">
        <label className="search">
          <Icon name="search" size={14} />
          <span className="sr-only">Search apps</span>
          <input placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <Seg
          label="Filter apps by status"
          value={filter}
          onChange={setFilter}
          options={[{ value: 'all', label: 'All' }, { value: 'live', label: 'Live' }, { value: 'draft', label: 'Draft' }]}
        />
        <div style={{ flex: 1 }} />
        <Link className="btn sm" href="/graph"><Icon name="share" size={14} /> App Graph</Link>
      </div>
      <div className="grid">
        {list.map((a) => <AppCard key={a.id} app={a} now={now} />)}
        <NewAppCard />
      </div>
      <ShareStoreModal open={sharing} onOpenChange={setSharing} me={me} apps={apps} />
    </main>
  );
}
