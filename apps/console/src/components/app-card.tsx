import Link from 'next/link';
import type { AppSummary } from '@/lib/api/types';
import { formatAgoShort, formatCompact } from '@/lib/format';
import { AppIcon, Icon, StatusPill } from './ui';

export function AppCard({ app, now }: { app: AppSummary; now: number }) {
  return (
    <Link className="app-card" href={`/app/${app.id}/screen`}>
      <div className="app-thumb" aria-hidden="true">
        <div className="mini">
          <i style={{ width: '40%' }} />
          <i style={{ width: '85%', height: 28, background: app.color }} />
          <i style={{ width: '70%' }} />
          <i style={{ width: '55%' }} />
        </div>
      </div>
      <div className="app-body">
        <div className="app-row">
          <AppIcon emoji={app.emoji} color={app.color} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="app-name">{app.name}</div>
            <div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              kelay.app/{app.handle}/{app.id}
            </div>
          </div>
          <StatusPill status={app.status} />
        </div>
        <div className="app-desc">{app.description}</div>
        <div className="app-meta" style={{ whiteSpace: 'nowrap' }}>
          <span title="Users"><Icon name="users" size={13} /> {app.users}<span className="sr-only"> users</span></span>
          <span title="Actions (30 days)"><Icon name="bolt" size={13} /> {formatCompact(app.runs)}<span className="sr-only"> actions</span></span>
          {app.newFeedback > 0 && (
            <span style={{ color: 'var(--accent)' }}><Icon name="inbox" size={13} /> {app.newFeedback} new<span className="sr-only"> feedback</span></span>
          )}
          <span style={{ marginLeft: 'auto' }}>{formatAgoShort(app.updatedAt, now)}</span>
        </div>
      </div>
    </Link>
  );
}

export function NewAppCard() {
  return (
    <Link href="/" className="new-card">
      <div>
        <div className="round"><Icon name="plus" size={20} /></div>
        <b>Build a new app</b>
        <div className="small">Describe it in one paragraph</div>
      </div>
    </Link>
  );
}
