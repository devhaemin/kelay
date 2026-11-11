'use client';

import Link from 'next/link';
import { useState } from 'react';
import { revokeConsentAction } from '@/app/actions';
import type { AppDetail, AssistantKind, Consent, ToolCall } from '@/lib/api/types';
import { FIXTURE_NOW, fixtureConsents, fixtureMembers, fixtureToolCalls, type TabMember } from '@/lib/api/workspace-fixtures';
import { firstName, formatAgo, formatDay, formatTime } from '@/lib/format';
import { CopyField } from '../../copy-button';
import { useToast } from '../../toast';
import { Avatar, Icon } from '../../ui';

function AssistantIcon({ kind, name }: { kind: AssistantKind; name: string }) {
  if (kind === 'claude') return <span className="asst claude" aria-hidden="true">C</span>;
  if (kind === 'cursor') return <span className="asst cursor" aria-hidden="true">Cu</span>;
  return <span className="asst" style={{ background: 'var(--muted)' }} aria-hidden="true">{name.charAt(0).toUpperCase()}</span>;
}

/** `['tickets:read', 'tickets:write', 'comments:write']` → "tickets: read, write · comments: write" */
function scopeSummary(scopes: readonly string[]): string {
  const byCollection = new Map<string, string[]>();
  for (const s of scopes) {
    const [collection = s, op = ''] = s.split(':');
    byCollection.set(collection, [...(byCollection.get(collection) ?? []), op]);
  }
  // A scope without an op (`offline_access`) stands on its own.
  return [...byCollection].map(([c, ops]) => (ops.some(Boolean) ? `${c}: ${ops.filter(Boolean).join(', ')}` : c)).join(' · ');
}

export default function AgentTab({
  app,
  members: membersProp,
  consents: consentsProp,
  toolCalls: toolCallsProp,
  now = FIXTURE_NOW,
}: {
  app: AppDetail;
  /** The data props default to the mock team; pass `now` together with real consents. */
  members?: TabMember[];
  consents?: Consent[];
  toolCalls?: ToolCall[];
  now?: number;
}) {
  const notify = useToast();
  const members = membersProp ?? fixtureMembers(app.id);
  // Activity keeps naming an assistant after it is disconnected, so lookups use the full list.
  const [fixtures] = useState<Consent[]>(() => (consentsProp ? [] : fixtureConsents(app.id)));
  const current = consentsProp ?? fixtures;
  // The server stops listing a consent once it is revoked; `known` remembers every one seen in this visit.
  const [known, setKnown] = useState(current);
  const unseen = current.filter((c) => !known.some((k) => k.id === c.id));
  if (unseen.length) setKnown([...known, ...unseen]);
  const [disconnected, setDisconnected] = useState<ReadonlySet<string>>(new Set());
  const toolCalls = toolCallsProp ?? fixtureToolCalls(app.id);
  const live = current.filter((c) => !disconnected.has(c.id));
  const today = formatDay(new Date(now).toISOString());
  const allToday = toolCalls.every((c) => formatDay(c.at) === today);
  const endpoint = app.mcpEndpoint;

  const memberOf = (userId: string): TabMember => members.find((m) => m.userId === userId) ?? { userId, name: 'Former member', role: '' };

  async function disconnect(id: string) {
    setDisconnected((prev) => new Set(prev).add(id));
    notify('Assistant disconnected — its token no longer works');
    const res = await revokeConsentAction(app.id, id);
    if (!res.ok) {
      setDisconnected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      notify(`Couldn’t disconnect — ${res.error}`);
    }
  }

  return (
    <>
      <div className="banner">
        <span className="switch on" aria-hidden="true" />
        <span>
          <b>Members can use {app.name} from their own AI assistant</b>{' '}
          <span className="muted">· over MCP · every call runs with their Kelay ID and the same access rules</span>
        </span>
      </div>
      <div className="two">
        <section className="card" aria-label="MCP endpoint">
          <div className="card-head">
            <h3><Icon name="link" size={15} /> MCP endpoint</h3>
            <span className="spacer" />
            <Link className="linkish" href={`/app/${app.id}/access`}>Access rules →</Link>
          </div>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <CopyField value={endpoint}>
              <span className="mono" style={{ color: 'var(--text)' }}>{endpoint}</span>
            </CopyField>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn sm" onClick={() => notify('Opening Claude to add the endpoint…')}>
                <AssistantIcon kind="claude" name="Claude" /> Add to Claude
              </button>
              <button type="button" className="btn sm" onClick={() => notify('Opening Cursor to add the endpoint…')}>
                <AssistantIcon kind="cursor" name="Cursor" /> Add to Cursor
              </button>
              <span className="small muted" style={{ alignSelf: 'center' }}>or paste the endpoint into any MCP client</span>
            </div>
            <div className="small muted" style={{ lineHeight: 1.5 }}>
              Conversations stay inside the member’s assistant. {app.name} only sees the tool calls.
            </div>
          </div>
          <div className="cost-row">
            <div><b>Assistant model cost</b>Paid by each member, in their own Claude or Cursor plan.</div>
            <div><b>App LLM budget</b>Used only when a tool runs this app’s agent graph.</div>
          </div>
        </section>
        <section className="card" aria-label="How a member connects">
          <div className="card-head"><h3>How a member connects</h3></div>
          <ol className="conn-steps" style={{ listStyle: 'none', margin: 0 }}>
            <li className="conn-step"><span className="n" aria-hidden="true">1</span><div><b>Add the endpoint</b> to their assistant.</div></li>
            <li className="conn-step"><span className="n" aria-hidden="true">2</span><div><b>Sign in with Kelay ID.</b> <span className="muted">The same account they use in the app.</span></div></li>
            <li className="conn-step"><span className="n" aria-hidden="true">3</span><div><b>Approve access to this app only.</b> <span className="muted">The consent screen names the assistant and the scopes it asks for.</span></div></li>
            <li className="conn-step"><span className="n" aria-hidden="true">4</span><div><b>Connected.</b> <span className="muted">The token is bound to this app × this member and can’t be used for any other app.</span></div></li>
          </ol>
        </section>
      </div>
      <section className="card" style={{ marginBottom: 16 }} aria-label="Connected assistants">
        <div className="card-head"><h3>Connected assistants</h3><span className="muted small">{live.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Assistant</th>
                <th scope="col">Scopes</th>
                <th scope="col">Connected</th>
                <th scope="col">Last call</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {live.map((c) => {
                const m = memberOf(c.userId);
                return (
                  <tr key={c.id}>
                    <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Avatar id={m.userId} name={m.name} color={m.color} /> {m.name}</span></td>
                    <td><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><AssistantIcon kind={c.client.kind} name={c.client.name} /> {c.client.name}</span></td>
                    <td className="muted">{scopeSummary(c.scopes)}</td>
                    <td className="muted">{formatDay(c.grantedAt)}</td>
                    <td className="muted">{formatAgo(c.lastUsedAt, now)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" className="btn sm" aria-label={`Disconnect ${firstName(m.name)}’s ${c.client.name}`} onClick={() => disconnect(c.id)}>
                        Disconnect
                      </button>
                    </td>
                  </tr>
                );
              })}
              {live.length === 0 && <tr><td colSpan={6} className="muted">No assistants connected.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" aria-label="Tool call activity">
        <div className="card-head">
          <h3>Tool call activity</h3>
          <span className="muted small">{allToday ? 'today' : 'latest'}</span>
          <span className="spacer" />
          <span className="small muted"><Icon name="lock" size={12} /> Tool calls only — no conversation content</span>
        </div>
        {toolCalls.map((call) => {
          const consent = known.find((c) => c.id === call.consentId);
          const m = memberOf(call.userId ?? consent?.userId ?? '');
          const assistant = call.clientName ?? consent?.client.name ?? 'assistant';
          return (
            <div className="act-row" key={call.id}>
              <Avatar id={m.userId} name={m.name} color={m.color} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{firstName(m.name)}’s {assistant}</b> called{' '}
                <span className="mono" style={{ color: 'var(--text)' }}>{call.tool}</span> <span className="muted">{call.args}</span>
                <div className="small muted">{allToday ? '' : `${formatDay(call.at)} · `}{formatTime(call.at)}{call.note ? ` · ${call.note}` : ''}</div>
              </div>
              {call.result === 'ok' ? <span className="pill green">OK</span> : <span className="pill red">{call.result === 'denied' ? 'Denied' : 'Error'}</span>}
            </div>
          );
        })}
        {toolCalls.length === 0 && <div className="empty">No tool calls yet.</div>}
      </section>
    </>
  );
}
