'use client';

import { useState } from 'react';
import type { BoardCard, Member } from '@/lib/api/types';
import { Avatar, Icon, Seg } from '../../ui';

const COLUMNS: readonly { key: BoardCard['column']; label: string }[] = [
  { key: 'todo', label: 'To do' },
  { key: 'progress', label: 'In progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];

/** Stand-in for the Ticket Board dev preview while no Builder workspace is running (mock data). */
export function BoardPreview({ board, members, viewerId, team }: { board: BoardCard[]; members: Member[]; viewerId: string; team: string }) {
  const [mine, setMine] = useState<'mine' | 'all'>('mine');
  const person = (id: string) => members.find((m) => m.userId === id);
  const viewer = person(viewerId);
  const visible = board.filter((t) => mine === 'all' || t.assigneeId === viewerId || t.createdBy === viewerId);
  const av = (id: string, size?: number) => {
    const p = person(id);
    return p ? <Avatar id={p.userId} name={p.name} color={p.color} size={size} /> : null;
  };

  return (
    <div aria-label="Ticket Board preview">
      <div className="mock-nav">
        <b>🎫 Ticket Board</b>
        <span className="muted">{team}</span>
        <span style={{ flex: 1 }} />
        <span className="muted">Projects</span>
        <span className="muted">Members</span>
        {viewer && av(viewer.userId, 24)}
      </div>
      <div className="mk-toolbar">
        <h2>Sprint 14</h2>
        <span style={{ flex: 1 }} />
        <Seg label="Board filter" value={mine} onChange={setMine} options={[{ value: 'mine', label: 'My tickets' }, { value: 'all', label: 'All' }]} />
        <button type="button" className="btn sm primary"><Icon name="plus" size={13} /> New ticket</button>
      </div>
      <div className="mk-board">
        {COLUMNS.map((c) => {
          const list = visible.filter((t) => t.column === c.key);
          return (
            <div key={c.key} className="mk-col">
              <h5>{c.label}<span>{list.length}</span></h5>
              {list.map((t) => (
                <div key={t.key} className="mk-card">
                  <div>{t.title}</div>
                  <div className="row"><span className="mono" style={{ fontSize: 11 }}>{t.key}</span><span style={{ flex: 1 }} />{av(t.assigneeId)}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="mk-feedback">
        <div className="slash-pop">
          <div className="on"><Icon name="msg" size={13} /> <code>/feedback</code> <span className="muted">Tell the builder what to improve</span></div>
          <div><Icon name="sparkle" size={13} /> <code>/ask</code> <span className="muted">Ask your own agent</span></div>
        </div>
        <Icon name="msg" size={14} />
        <span className="typed"><b>/feedback</b> I only want to see my tickets</span>
        <button type="button" className="send" style={{ width: 28, height: 28 }} aria-label="Send feedback"><Icon name="up" size={13} /></button>
      </div>
    </div>
  );
}
