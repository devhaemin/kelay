'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useRef } from 'react';
import type { AppDetail, Member, Preview } from '@/lib/api/types';
import { firstName } from '@/lib/format';
import { roleName } from '@/lib/policy';
import { useUiPrefs } from '../../providers';
import { Icon, Seg } from '../../ui';
import { BoardPreview } from './board-preview';

export function ScreenView({ app, preview, members, team }: { app: AppDetail; preview: Preview; members: Member[]; team: string }) {
  const { device, setDevice } = useUiPrefs();
  const frame = useRef<HTMLIFrameElement>(null);
  const viewer = members.find((m) => m.role === 'member') ?? members[0] ?? null;
  const openUrl = preview?.kind === 'url' ? preview.url : app.productionUrl;

  return (
    <div className="preview-wrap">
      {app.pendingChange && (
        <div className="banner">
          <span className="pill blue"><span className="dot" />{app.pendingChange.count} change{app.pendingChange.count === 1 ? '' : 's'}</span>
          <span><b>Unpublished change:</b> <span className="muted">{app.pendingChange.title}</span></span>
          <span className="spacer" />
          <button type="button" className="btn sm ghost">Discard</button>
          <Link className="btn sm primary" href={`/app/${app.id}/screen/ship`}>Ship it</Link>
        </div>
      )}
      <div className="preview-bar">
        <Seg
          label="Preview device"
          value={device}
          onChange={setDevice}
          options={[
            { value: 'pc', label: <Icon name="monitor" size={14} />, ariaLabel: 'Desktop' },
            { value: 'mobile', label: <Icon name="phone" size={14} />, ariaLabel: 'Phone' },
          ]}
        />
        <div className="url">
          <Icon name="lock" size={13} /> kelay.app/{app.handle}/{app.id}
          {preview?.kind === 'fixture' && viewer && (
            <span className="pill" style={{ marginLeft: 6 }}>preview as {firstName(viewer.name)} · {roleName(viewer.role)}</span>
          )}
        </div>
        <button
          type="button"
          className="btn sm ghost"
          aria-label="Reload preview"
          onClick={() => {
            if (frame.current) frame.current.src = frame.current.src;
          }}
        >
          <Icon name="refresh" size={14} />
        </button>
        <a className="btn sm ghost" href={openUrl} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab"><Icon name="ext" size={14} /></a>
      </div>
      <div className="stage">
        <div className={clsx('device', device === 'mobile' && 'mobile')}>
          {preview?.kind === 'url' ? (
            <iframe ref={frame} className="preview-frame" src={preview.url} title={`${app.name} dev preview`} />
          ) : preview?.kind === 'fixture' && viewer ? (
            <BoardPreview board={preview.board} members={members} viewerId={viewer.userId} team={team} />
          ) : (
            <div className="empty">
              <b>Dev preview isn’t running</b>
              <div>It starts when the Builder workspace for {app.name} opens. Ask the agent for a change to wake it up.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
