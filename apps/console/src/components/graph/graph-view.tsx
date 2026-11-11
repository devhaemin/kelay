'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/action-result';
import { AGENTS_NODE, IDENTITY_NODE, type AppSummary, type Consent, type Grant, type GrantRequest, type GraphOverview } from '@/lib/api/types';
import { formatCompact, formatDay } from '@/lib/format';
import { layoutGraph, mcpEndpointFor, nodeName, related, type Selection } from '@/lib/graph';
import { useServerState } from '@/lib/use-server-state';
import { CopyButton } from '../copy-button';
import { useToast } from '../toast';
import { AppIcon, Icon, ProtoTag, StatusPill } from '../ui';
import { ConnectAppsModal } from './connect-apps-modal';

export interface GraphViewProps {
  apps: AppSummary[];
  grants: Grant[];
  consents: Consent[];
  overview: GraphOverview | null;
  focus: string | null;
  onAllow: (id: string) => Promise<ActionResult<Grant>>;
  onReject: (id: string) => Promise<ActionResult<Grant>>;
  onRequest: (input: GrantRequest) => Promise<ActionResult<Grant>>;
}

const selectionFor = (focus: string | null, apps: AppSummary[], grants: Grant[]): Selection => {
  if (!focus) return null;
  if (focus === IDENTITY_NODE || focus === AGENTS_NODE || apps.some((a) => a.id === focus)) return { type: 'node', id: focus };
  return grants.some((g) => g.id === focus) ? { type: 'link', id: focus } : null;
};

const edgeStroke = (l: Grant) => (l.status === 'pending' ? '#e0a548' : l.kind === 'A2A' ? '#8b5cf6' : '#7c8ad6');

export function GraphView({ apps, grants: initialGrants, consents, overview, focus, onAllow, onReject, onRequest }: GraphViewProps) {
  const toast = useToast();
  const [links, setLinks] = useServerState(initialGrants);
  const [sel, setSel] = useState<Selection>(() => selectionFor(focus, apps, initialGrants));
  const [seenFocus, setSeenFocus] = useState(focus);
  if (seenFocus !== focus) {
    setSeenFocus(focus);
    setSel(selectionFor(focus, apps, links));
  }
  const [connecting, setConnecting] = useState(false);
  const [busy, startTransition] = useTransition();

  const name = (id: string) => nodeName(apps, id);
  const pending = links.filter((l) => l.status === 'pending');
  const live = links.filter((l) => l.status === 'connected');
  const people = overview?.people ?? Math.max(0, ...apps.map((a) => a.users));
  const pos = layoutGraph(apps);
  const rel = related(sel, apps, links);

  function selectLink(id: string) {
    setSel({ type: 'link', id });
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
  }

  function allow(id: string) {
    startTransition(async () => {
      const r = await onAllow(id);
      if (!r.ok) return toast(r.error);
      setLinks((prev) => prev.map((l) => (l.id === id ? r.data : l)));
      setSel({ type: 'link', id });
      toast(`${name(r.data.from)} can now call ${name(r.data.to)}`);
    });
  }

  function reject(id: string) {
    startTransition(async () => {
      const r = await onReject(id);
      if (!r.ok) return toast(r.error);
      setLinks((prev) => prev.filter((l) => l.id !== id));
      setSel(null);
      toast('Connection request rejected');
    });
  }

  return (
    <main className="page" style={{ maxWidth: 1320 }}>
      <div className="page-title">
        <div>
          <h1>App Graph</h1>
          <p>Your apps, how they call each other, and the one identity your users share.</p>
        </div>
        <button type="button" className="btn" onClick={() => setConnecting(true)}><Icon name="plus" size={14} /> Connect apps</button>
      </div>

      {pending.map((l) => (
        <div key={l.id} className="banner" role="region" aria-label={`Connection request from ${name(l.from)}`} style={{ borderColor: '#f3dcb0', background: 'var(--amber-soft)' }}>
          <ProtoTag kind={l.kind} />
          <span>
            <b>{name(l.from)}</b> wants to call <b>{name(l.to)}</b> <span className="muted">— {l.what.toLowerCase()}</span>
          </span>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => selectLink(l.id)}>Details</button>
          <button type="button" className="btn sm" disabled={busy} onClick={() => reject(l.id)}>Reject</button>
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => allow(l.id)}>Allow</button>
        </div>
      ))}

      <div className="kpis">
        <div className="kpi"><div className="label">Apps</div><div className="val">{apps.length}</div><div className="delta muted">{apps.filter((a) => a.status === 'live').length} live</div></div>
        <div className="kpi"><div className="label">Connections</div><div className="val">{live.length}</div><div className="delta muted">{pending.length} pending</div></div>
        <div className="kpi">
          <div className="label">Cross-app calls / day</div>
          <div className="val">{live.reduce((s, l) => s + l.callsPerDay, 0)}</div>
          {overview?.callsDeltaPct != null && <div className="delta up">▲ {overview.callsDeltaPct}% this week</div>}
        </div>
        <div className="kpi">
          <div className="label">People (one Kelay ID)</div>
          <div className="val">{people}</div>
          {overview && <div className="delta muted">{overview.multiAppPeople} use 2+ apps</div>}
        </div>
      </div>

      <div className="graph-page">
        <div className="card">
          <div className="card-head">
            <h3>Graph</h3>
            <span className="spacer" />
            <div className="legend" aria-hidden="true">
              <span><i style={{ borderColor: '#7c8ad6' }} />MCP</span>
              <span><i style={{ borderColor: '#8b5cf6' }} />A2A</span>
              <span><i style={{ borderColor: '#e0a548', borderTopStyle: 'dashed' }} />Pending</span>
              <span><i style={{ borderColor: '#c9c6bd', borderTopStyle: 'dotted' }} />Identity</span>
            </div>
            {sel && <button type="button" className="btn sm ghost" onClick={() => setSel(null)}>Clear</button>}
          </div>
          <div className="app-graph">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {apps.map((a) => (
                <line
                  key={`id-${a.id}`}
                  x1={pos[IDENTITY_NODE]!.x} y1={pos[IDENTITY_NODE]!.y} x2={pos[a.id]!.x} y2={pos[a.id]!.y}
                  stroke="#c9c6bd" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" style={{ strokeWidth: '1.5px' }}
                  className={clsx(rel && !rel.ident.has(a.id) && 'dim')}
                />
              ))}
              {links.filter((l) => pos[l.from] && pos[l.to]).map((l) => (
                <line
                  key={l.id}
                  x1={pos[l.from]!.x} y1={pos[l.from]!.y} x2={pos[l.to]!.x} y2={pos[l.to]!.y}
                  stroke={edgeStroke(l)} strokeDasharray={l.status === 'pending' ? '6 5' : undefined} vectorEffect="non-scaling-stroke"
                  style={{ strokeWidth: `${l.status === 'pending' ? 2 : Math.max(1.5, Math.min(4, l.callsPerDay / 20))}px` }}
                  className={clsx(rel && !rel.links.has(l.id) && 'dim')}
                />
              ))}
            </svg>
            {links.filter((l) => pos[l.from] && pos[l.to]).map((l) => (
              <button
                key={l.id}
                type="button"
                className={clsx('elabel', l.status === 'pending' && 'pending', sel?.type === 'link' && sel.id === l.id && 'sel', rel && !rel.links.has(l.id) && 'dim')}
                style={{ left: `${(pos[l.from]!.x + pos[l.to]!.x) / 2}%`, top: `${(pos[l.from]!.y + pos[l.to]!.y) / 2}%` }}
                aria-label={`${name(l.from)} to ${name(l.to)}, ${l.kind}, ${l.status === 'pending' ? 'waiting for you' : `${l.callsPerDay} calls a day`}`}
                aria-pressed={sel?.type === 'link' && sel.id === l.id}
                onClick={() => selectLink(l.id)}
              >
                {l.status === 'pending' ? `${l.kind} · waiting for you` : `${l.kind} · ${l.callsPerDay}/day`}
              </button>
            ))}
            <GraphNode id={IDENTITY_NODE} pos={pos} sel={sel} rel={rel} onSelect={setSel} className="identity">
              <div className="app-icon"><Icon name="user" size={14} /></div>
              <div><div className="n">Kelay ID</div><div className="s">{people} people · one sign-in</div></div>
            </GraphNode>
            <GraphNode id={AGENTS_NODE} pos={pos} sel={sel} rel={rel} onSelect={setSel} className="external">
              <div className="app-icon" style={{ background: 'var(--surface-2)' }}><Icon name="cpu" size={14} /></div>
              <div><div className="n">Personal agents</div><div className="s">members’ own AI assistants</div></div>
            </GraphNode>
            {apps.map((a) => (
              <GraphNode key={a.id} id={a.id} pos={pos} sel={sel} rel={rel} onSelect={setSel} className={a.status === 'live' ? undefined : 'off'}>
                <AppIcon emoji={a.emoji} color={a.color} size={28} />
                <div>
                  <div className="n">{a.name}</div>
                  <div className="s">
                    {a.status === 'live' && <span className="dot" style={{ color: 'var(--green)' }} />}
                    {a.users} users{a.status !== 'live' ? ` · ${a.status}` : ''}
                  </div>
                </div>
              </GraphNode>
            ))}
          </div>
        </div>
        <div className="card" aria-live="polite">
          <GraphPanel sel={sel} apps={apps} links={links} consents={consents} people={people} overview={overview} busy={busy} onSelect={setSel} onAllow={allow} onReject={reject} />
        </div>
      </div>

      <div className="card table-wrap">
        <div className="card-head"><h3>All connections</h3></div>
        <table>
          <thead>
            <tr><th>From</th><th><span className="sr-only">Direction</span></th><th>To</th><th>What it does</th><th>Protocol</th><th>Calls / day</th><th>Since</th><th>Status</th></tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id} onClick={() => selectLink(l.id)} style={{ cursor: 'pointer' }}>
                <td><button type="button" className="linkbtn" onClick={(e) => { e.stopPropagation(); selectLink(l.id); }}>{name(l.from)}</button></td>
                <td className="muted" aria-hidden="true">→</td>
                <td>{name(l.to)}</td>
                <td className="muted">{l.what}</td>
                <td><ProtoTag kind={l.kind} /></td>
                <td>{l.status === 'pending' ? '—' : l.callsPerDay}</td>
                <td className="muted">{formatDay(l.since)}</td>
                <td>{l.status === 'pending' ? <span className="pill amber">Pending</span> : <span className="pill green">Connected</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConnectAppsModal
        open={connecting}
        onOpenChange={setConnecting}
        apps={apps}
        onRequest={async (input) => {
          const r = await onRequest(input);
          if (r.ok) {
            setLinks((prev) => [...prev, r.data]);
            setSel({ type: 'link', id: r.data.id });
            toast(`Requested: ${name(r.data.from)} → ${name(r.data.to)}`);
          }
          return r;
        }}
      />
    </main>
  );
}

function GraphNode({
  id, pos, sel, rel, onSelect, className, children,
}: {
  id: string;
  pos: Record<string, { x: number; y: number }>;
  sel: Selection;
  rel: ReturnType<typeof related>;
  onSelect: (s: Selection) => void;
  className?: string | undefined;
  children: React.ReactNode;
}) {
  const p = pos[id];
  if (!p) return null;
  const selected = sel?.type === 'node' && sel.id === id;
  return (
    <button
      type="button"
      className={clsx('anode', className, selected && 'sel', rel && !rel.nodes.has(id) && 'dim')}
      style={{ left: `${p.x}%`, top: `${p.y}%` }}
      aria-pressed={selected}
      onClick={() => onSelect({ type: 'node', id })}
    >
      {children}
    </button>
  );
}

function GraphPanel({
  sel, apps, links, consents, people, overview, busy, onSelect, onAllow, onReject,
}: {
  sel: Selection;
  apps: AppSummary[];
  links: Grant[];
  consents: Consent[];
  people: number;
  overview: GraphOverview | null;
  busy: boolean;
  onSelect: (s: Selection) => void;
  onAllow: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const name = (id: string) => nodeName(apps, id);

  if (!sel) {
    return (
      <>
        <div className="card-head"><h3>Apps</h3><span className="spacer" /><span className="small muted">Click to trace</span></div>
        {apps.map((a) => {
          const n = links.filter((l) => l.from === a.id || l.to === a.id);
          const p = n.filter((l) => l.status === 'pending').length;
          return (
            <button key={a.id} type="button" className="conn-row" onClick={() => onSelect({ type: 'node', id: a.id })}>
              <AppIcon emoji={a.emoji} color={a.color} size={26} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{a.name}</div>
                <div className="what">{n.length ? `${n.length} connection${n.length > 1 ? 's' : ''}` : 'Not connected'}</div>
              </div>
              {p > 0 && <span className="pill amber">{p} pending</span>}
            </button>
          );
        })}
      </>
    );
  }

  if (sel.type === 'link') {
    const l = links.find((x) => x.id === sel.id);
    if (!l) return <div className="empty">This connection no longer exists.</div>;
    const appEnd = l.to === AGENTS_NODE ? l.from : l.to;
    return (
      <>
        <div className="card-head">
          <ProtoTag kind={l.kind} /><h3>Connection</h3><span className="spacer" />
          {l.status === 'pending' ? <span className="pill amber">Waiting for approval</span> : <span className="pill green">Connected</span>}
        </div>
        <div className="node-detail">
          <div style={{ fontWeight: 600 }}>{name(l.from)} → {name(l.to)}</div>
          <div className="muted" style={{ lineHeight: 1.5 }}>{l.what}</div>
          <dl className="kv">
            <dt>Protocol</dt><dd>{l.kind === 'MCP' ? 'MCP · tool call' : 'A2A · agent hand-off'}</dd>
            <dt>{l.status === 'pending' ? 'Requested' : 'Approved'}</dt><dd>{formatDay(l.since)}</dd>
            <dt>Calls / day</dt><dd>{l.status === 'pending' ? '—' : l.callsPerDay}</dd>
            <dt>Runs as</dt><dd>The signed-in member</dd>
          </dl>
          <div className="small muted" style={{ lineHeight: 1.5 }}>
            Each call keeps the member’s own Kelay ID. {name(l.to)}’s access rules still apply, so nobody gets more than they already have.
          </div>
          {l.status === 'pending' ? (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn sm" disabled={busy} onClick={() => onReject(l.id)}>Reject</button>
                <button type="button" className="btn sm primary" disabled={busy} onClick={() => onAllow(l.id)}><Icon name="check" size={14} /> Allow</button>
              </div>
              {l.proposalId && <div className="small muted">Proposed in an improvement report.</div>}
            </>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <Link className="btn sm" href={`/app/${appEnd}/monitoring`}>View calls</Link>
              <button type="button" className="btn sm" style={{ color: 'var(--red)' }}>Pause</button>
            </div>
          )}
        </div>
      </>
    );
  }

  const k = sel.id;
  if (k === IDENTITY_NODE) {
    return (
      <>
        <div className="card-head"><h3>Kelay ID</h3><span className="spacer" /><span className="pill blue">Identity</span></div>
        <div className="node-detail">
          <div className="muted" style={{ lineHeight: 1.5 }}>People sign in once and open every app you publish. Each app keeps its own roles and access rules.</div>
          <dl className="kv">
            {apps.map((a) => [<dt key={`t-${a.id}`}>{a.emoji} {a.name}</dt>, <dd key={`d-${a.id}`}>{a.users} users</dd>])}
          </dl>
          <div className="small muted">{people} people{overview ? ` · ${overview.multiAppPeople} use 2+ apps` : ''}</div>
        </div>
      </>
    );
  }

  if (k === AGENTS_NODE) {
    const ls = links.filter((l) => l.from === AGENTS_NODE);
    const members = new Set(consents.map((c) => c.userId)).size;
    const firstApp = ls[0]?.to ?? apps[0]?.id;
    return (
      <>
        <div className="card-head"><h3>Personal agents</h3><span className="spacer" /><span className="pill">External</span></div>
        <div className="node-detail">
          <div className="muted" style={{ lineHeight: 1.5 }}>
            Members’ own AI assistants (Claude Desktop, Cursor…) call your apps over MCP. Each call runs with that member’s Kelay ID and the same access rules.
          </div>
          <dl className="kv">
            <dt>Apps reached</dt><dd>{ls.length}</dd>
            <dt>Calls / day</dt><dd>{ls.reduce((s, l) => s + l.callsPerDay, 0)}</dd>
            <dt>Members</dt><dd>{members} connected</dd>
          </dl>
          {firstApp && <Link className="btn sm" href={`/app/${firstApp}/agent`} style={{ alignSelf: 'flex-start' }}>Agent settings</Link>}
        </div>
      </>
    );
  }

  const a = apps.find((x) => x.id === k);
  if (!a) return <div className="empty">This app is no longer in your graph.</div>;
  const ls = links.filter((l) => l.from === k || l.to === k);
  const endpoint = mcpEndpointFor(a);
  return (
    <>
      <div className="card-head">
        <AppIcon emoji={a.emoji} color={a.color} size={26} /><h3>{a.name}</h3><span className="spacer" /><StatusPill status={a.status} />
      </div>
      <div className="node-detail" style={{ paddingBottom: 4 }}>
        <dl className="kv">
          <dt>Users</dt><dd>{a.users}</dd>
          <dt>Actions</dt><dd>{formatCompact(a.runs)}</dd>
          <dt>Connections</dt><dd>{ls.length}</dd>
        </dl>
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>MCP endpoint</div>
          <div className="url" style={{ height: 30, fontSize: 12 }}>
            <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{endpoint}</span>
            <CopyButton value={endpoint} plain className="ghost" style={{ height: 22 }} />
          </div>
        </div>
      </div>
      {ls.map((l) => (
        <button key={l.id} type="button" className="conn-row" onClick={() => onSelect({ type: 'link', id: l.id })}>
          <ProtoTag kind={l.kind} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>{l.from === k ? `→ ${name(l.to)}` : `← ${name(l.from)}`}</div>
            <div className="what">{l.what}</div>
          </div>
          {l.status === 'pending' && <span className="pill amber">Pending</span>}
        </button>
      ))}
      <div className="node-detail" style={{ paddingTop: 8 }}>
        <Link className="btn sm primary" href={`/app/${a.id}/screen`} style={{ alignSelf: 'flex-start' }}>Open app <Icon name="ext" size={13} /></Link>
      </div>
    </>
  );
}
