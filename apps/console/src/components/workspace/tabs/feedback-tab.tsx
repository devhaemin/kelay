'use client';

import clsx from 'clsx';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { ME, PEOPLE, REPORTS, TICKETS } from '@/lib/api/fixtures';
import type { AppSummary, FeedbackTicket, ImprovementReport, Priority, ProposalState, TicketStatus, TicketType } from '@/lib/api/types';
import { formatLongDate } from '@/lib/format';
import { CloseButton, DialogTitle, Drawer } from '../../dialogs';
import { useUiPrefs } from '../../providers';
import { useToast } from '../../toast';
import { Avatar, Icon, RichText } from '../../ui';
import styles from './feedback-tab.module.css';

interface Person {
  userId: string;
  name: string;
  color?: string | undefined;
}

export interface FeedbackTabProps {
  app: Pick<AppSummary, 'id' | 'name'>;
  /** Default to the mock fixtures for this app. */
  tickets?: FeedbackTicket[];
  /** Newest first. */
  reports?: ImprovementReport[];
  people?: Person[];
  /** Team the reporters belong to, shown in the ticket drawer. */
  team?: string;
  /** Lets the shell persist a decision (server action) and refresh the tab count. */
  onProposalChange?: (proposalId: string, state: ProposalState) => void;
}

const COLUMNS: { status: TicketStatus; label: string; tone: 'blue' | 'amber' | 'violet' | 'green' }[] = [
  { status: 'new', label: 'New', tone: 'blue' },
  { status: 'triaged', label: 'Triaged', tone: 'amber' },
  { status: 'progress', label: 'In progress', tone: 'violet' },
  { status: 'done', label: 'Done', tone: 'green' },
];

const TYPE_TAG: Record<TicketType, { label: string; className: string }> = {
  bug: { label: 'Bug', className: 'type-bug' },
  ux: { label: 'UX', className: 'type-ux' },
  feat: { label: 'Feature', className: 'type-feat' },
  quality: { label: 'Quality', className: 'type-quality' },
};

const PRIORITY: Record<Priority, { glyph: string; color: string; label: string }> = {
  high: { glyph: '▲', color: 'var(--red)', label: 'High priority' },
  med: { glyph: '■', color: 'var(--amber)', label: 'Medium priority' },
  low: { glyph: '▼', color: 'var(--faint)', label: 'Low priority' },
};

type TypeFilter = 'all' | TicketType;

export default function FeedbackTab({ app, tickets: ticketsProp, reports: reportsProp, people = PEOPLE, team = ME.team, onProposalChange }: FeedbackTabProps) {
  const toast = useToast();
  const { setChatOpen } = useUiPrefs();
  const headingId = useId();

  const tickets = useMemo(() => ticketsProp ?? TICKETS.filter((t) => t.app === app.id), [ticketsProp, app.id]);
  const reports = useMemo(
    () => reportsProp ?? REPORTS.filter((r) => r.app === app.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [reportsProp, app.id],
  );

  const [reportId, setReportId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ProposalState>>({});
  const [highlight, setHighlight] = useState<string[]>([]);
  const [jump, setJump] = useState<{ key: string } | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sent, setSent] = useState<Record<string, string[]>>({});
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');

  const report = reports.find((r) => r.id === reportId) ?? reports[0] ?? null;
  const proposals = report?.proposals ?? [];
  const stateOf = (p: { id: string; state: ProposalState }): ProposalState => decisions[p.id] ?? p.state;
  const approved = proposals.filter((p) => stateOf(p) === 'approved').length;
  const pending = proposals.filter((p) => stateOf(p) === 'pending');

  const decide = (ids: string[], state: ProposalState) => {
    setDecisions((d) => ({ ...d, ...Object.fromEntries(ids.map((id) => [id, state])) }));
    ids.forEach((id) => onProposalChange?.(id, state));
  };

  // The ticket has to be on the board before it can be scrolled to, so the scroll waits for the
  // render that clears any filter hiding it.
  useEffect(() => {
    if (!jump) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(`t-${jump.key}`)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }, [jump]);

  const showRef = (ref: string) => {
    const owner = proposals.find((p) => p.refs.includes(ref));
    setHighlight(owner ? owner.refs : [ref]);
    setQuery('');
    setTypeFilter('all');
    setJump({ key: ref });
  };

  const q = query.trim().toLowerCase();
  const visible = tickets.filter(
    (t) =>
      (typeFilter === 'all' || t.type === typeFilter) &&
      (!q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || t.quote.toLowerCase().includes(q)),
  );

  const open = openKey ? tickets.find((t) => t.key === openKey) ?? null : null;
  const person = (id: string): Person => people.find((p) => p.userId === id) ?? { userId: id, name: 'Member' };
  const openTicket = (key: string) => {
    setOpenKey(key);
    setReplying(false);
    setDraft('');
  };

  const sendReply = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!open || !text) return;
    setSent((s) => ({ ...s, [open.key]: [...(s[open.key] ?? []), text] }));
    setDraft('');
    setReplying(false);
    toast(`Reply sent to ${person(open.reporterId).name}`);
  };

  return (
    <>
      <ol className={clsx('flow', styles.flowList)} role="list" aria-label="How feedback becomes improvements">
        <li className="flow-step"><b><Icon name="msg" size={14} /> In the app</b>Members type <code>/feedback</code> anywhere in {app.name}.</li>
        <FlowArrow />
        <li className="flow-step"><b><Icon name="inbox" size={14} /> Tickets here</b>Valid feedback lands below. Noise and duplicates are merged.</li>
        <FlowArrow />
        <li className="flow-step"><b><Icon name="sparkle" size={14} /> Daily report</b>The Self-Improvement Agent proposes what to change.</li>
        <FlowArrow />
        <li className="flow-step"><b><Icon name="check" size={14} /> You approve</b>Approved items are built in Development, then shipped.</li>
        <FlowArrow />
        <li className="flow-step"><b><Icon name="undo" size={14} /> Reply back</b>The people who asked get a reply when it ships.</li>
      </ol>

      <section className="report" aria-labelledby={`${headingId}-report`}>
        <div className="report-head">
          <div className="agent-badge" aria-hidden="true"><Icon name="sparkle" size={18} /></div>
          <div style={{ flex: 1 }}>
            <h2 id={`${headingId}-report`} style={{ fontWeight: 600, fontSize: 'inherit', margin: 0 }}>Daily improvement report</h2>
            <div className="small muted">
              {report ? (
                <>
                  <Icon name="calendar" size={12} /> {formatLongDate(report.createdAt)} · {report.author} · from {report.messages} feedback messages ({report.valid} valid, {report.messages - report.valid} merged or noise)
                </>
              ) : (
                'Self-Improvement Agent'
              )}
            </div>
          </div>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="btn sm ghost" disabled={reports.length < 2}>
              Previous reports <Icon name="chev" size={14} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
                <DropdownMenu.RadioGroup value={report?.id ?? ''} onValueChange={(id) => { setReportId(id); setHighlight([]); }}>
                  {reports.map((r) => (
                    <DropdownMenu.RadioItem key={r.id} className="menu-item" value={r.id}>
                      <span style={{ flex: 1 }}>{formatLongDate(r.createdAt)}</span>
                      <span className="small muted">{r.proposals.length} {r.proposals.length === 1 ? 'proposal' : 'proposals'}</span>
                      <DropdownMenu.ItemIndicator><Icon name="check" size={14} /></DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        {report ? (
          <div className="report-summary"><RichText text={report.summary} /></div>
        ) : (
          <div className={styles.empty}>No report yet. The first one arrives the morning after members send <code>/feedback</code>.</div>
        )}
        <ol className={styles.reset} role="list">
          {proposals.map((p, i) => {
            const s = stateOf(p);
            return (
              <li key={p.id} className={clsx('proposal', s)}>
                <div className="num" aria-hidden="true">{i + 1}</div>
                <div>
                  <h4>{p.title}</h4>
                  <p>{p.body}</p>
                  <div className="refs">
                    <span className="pill">Impact: {p.impact}</span>
                    <span className="pill">Effort: {p.effort}</span>
                    <span className="pill">Changes: {p.affects}</span>
                    {p.refs.map((r) => (
                      <button key={r} type="button" className="ticket-ref" aria-label={`Show ticket ${r} on the board`} onClick={() => showRef(r)}>
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="proposal-actions">
                  {s === 'pending' ? (
                    <>
                      <button type="button" className="btn sm" aria-label={`Reject: ${p.title}`} onClick={() => decide([p.id], 'rejected')}>Reject</button>
                      <button
                        type="button"
                        className="btn sm primary"
                        aria-label={`Approve: ${p.title}`}
                        onClick={() => {
                          decide([p.id], 'approved');
                          toast(p.grantId ? `Approved — ${app.name} can now write to Team Wiki` : 'Approved — building it in Development');
                        }}
                      >
                        <Icon name="check" size={14} /> Approve
                      </button>
                    </>
                  ) : (
                    <>
                      {s === 'approved' ? (
                        <span className="pill green"><Icon name="check" size={12} /> Approved{p.grantId ? ' · connected' : ' · building in Dev'}</span>
                      ) : (
                        <span className="pill">Rejected</span>
                      )}
                      <button type="button" className="btn sm ghost" aria-label={`Undo: ${p.title}`} onClick={() => decide([p.id], 'pending')}>Undo</button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="report-foot">
          <span className="small muted" role="status">{approved} of {proposals.length} approved</span>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => setChatOpen(true)}>Ask about this report</button>
          <button
            type="button"
            className="btn sm accent"
            disabled={pending.length === 0}
            onClick={() => {
              decide(pending.map((p) => p.id), 'approved');
              toast('All proposals approved');
            }}
          >
            <Icon name="check" size={14} /> Approve all
          </button>
        </div>
      </section>

      <div className="section-head">
        <h2 id={`${headingId}-tickets`}>Feedback tickets</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <label className="search" style={{ minWidth: 200 }}>
            <Icon name="search" size={14} />
            <span className="sr-only">Search tickets</span>
            <input placeholder="Search tickets" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="btn sm" aria-label={typeFilter === 'all' ? 'Filter by type' : `Filter by type: ${TYPE_TAG[typeFilter].label}`}>
              <Icon name="filter" size={14} /> Type{typeFilter !== 'all' && `: ${TYPE_TAG[typeFilter].label}`}
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu" align="end" sideOffset={6} style={{ minWidth: 160 }}>
                <DropdownMenu.RadioGroup value={typeFilter} onValueChange={(v) => setTypeFilter(v as TypeFilter)}>
                  {(['all', 'bug', 'ux', 'feat', 'quality'] as const).map((v) => (
                    <DropdownMenu.RadioItem key={v} className="menu-item" value={v}>
                      <span style={{ flex: 1 }}>{v === 'all' ? 'All types' : TYPE_TAG[v].label}</span>
                      <DropdownMenu.ItemIndicator><Icon name="check" size={14} /></DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
      <div className="board" role="group" aria-labelledby={`${headingId}-tickets`}>
        {COLUMNS.map((c) => {
          const list = visible.filter((t) => t.status === c.status);
          const colId = `${headingId}-col-${c.status}`;
          return (
            <section key={c.status} className="col" aria-labelledby={colId}>
              <div className="col-head">
                <h3 id={colId} style={{ margin: 0, font: 'inherit', display: 'inline-flex' }}>
                  <span className={clsx('pill', c.tone !== 'violet' && c.tone)} style={c.tone === 'violet' ? { background: '#f1eafe', color: 'var(--violet)' } : undefined}>
                    <span className="dot" />{c.label}
                  </span>
                </h3>
                <span className="n" aria-label={`${list.length} tickets`}>{list.length}</span>
              </div>
              <ul className={styles.reset} role="list">
                {list.map((t) => {
                  const prio = PRIORITY[t.priority];
                  const by = person(t.reporterId);
                  const replies = t.replies + (sent[t.key]?.length ?? 0);
                  return (
                    <li key={t.key}>
                      <button
                        type="button"
                        id={`t-${t.key}`}
                        className={clsx('ticket', highlight.includes(t.key) && 'hl')}
                        aria-haspopup="dialog"
                        aria-expanded={openKey === t.key}
                        onClick={() => openTicket(t.key)}
                      >
                        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span className="mono">{t.key}</span>
                          <span className={clsx('type-tag', TYPE_TAG[t.type].className)}>{TYPE_TAG[t.type].label}</span>
                          <span style={{ flex: 1 }} />
                          <span className="prio" style={{ color: prio.color }} role="img" aria-label={prio.label}>{prio.glyph}</span>
                        </span>
                        <span className="title">{t.title}</span>
                        <span className="quote">{t.quote}</span>
                        <span className="foot">
                          <Avatar id={by.userId} name={by.name} color={by.color} size={18} />
                          <span className="sr-only">From {by.name},</span>
                          <span aria-hidden="true">▲ {t.votes}</span>
                          <span className="sr-only">{t.votes} votes,</span>
                          <span aria-hidden="true">· <Icon name="msg" size={12} /> {replies}</span>
                          <span className="sr-only">{replies} replies</span>
                          <span className="spacer" />
                          {t.fixedIn ? (
                            <span className="pill green" style={{ height: 18 }}><span className="sr-only">Fixed in </span>{t.fixedIn}</span>
                          ) : (
                            <span>/feedback</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <Drawer open={open !== null} onOpenChange={(o) => { if (!o) setOpenKey(null); }}>
        {open && (
          <>
            <div className="card-head">
              <span className="mono">{open.key}</span>
              <DialogTitle asChild><h3 style={{ flex: 1 }}>{open.title}</h3></DialogTitle>
              <CloseButton />
            </div>
            <div className="drawer-body">
              <dl className="kv">
                <dt>From</dt><dd>{person(open.reporterId).name} · {team}</dd>
                <dt>Channel</dt><dd>/feedback in {app.name}</dd>
                <dt>Votes</dt><dd>▲ {open.votes} people</dd>
                <dt>Status</dt>
                <dd>{open.fixedIn ? <span className="pill green">Fixed in {open.fixedIn}</span> : <span className="pill">{open.status}</span>}</dd>
              </dl>
              <div>
                <h4>Conversation</h4>
                <div className={styles.thread}>
                  <div className="bubble"><div className="who">{person(open.reporterId).name} · /feedback</div>{open.quote.replace(/[“”]/g, '')}</div>
                  <div className="bubble agent">
                    <div className="who">Kelay · auto-reply</div>
                    Thanks! Logged as {open.key}. {open.votes - 1} others asked for the same. We’ll tell you when it ships.
                  </div>
                  {open.fixedIn && (
                    <div className="bubble agent">
                      <div className="who">Kelay · after you approved</div>
                      This is fixed in {open.fixedIn}. Try it again — and send another /feedback if anything’s off.
                    </div>
                  )}
                  {(sent[open.key] ?? []).map((text, i) => (
                    <div key={i} className="bubble agent"><div className="who">{ME.name} · reply</div>{text}</div>
                  ))}
                </div>
              </div>
              {replying ? (
                <form className={styles.reply} onSubmit={sendReply}>
                  <label className="sr-only" htmlFor={`${headingId}-reply`}>Reply to {person(open.reporterId).name}</label>
                  <textarea
                    id={`${headingId}-reply`}
                    autoFocus
                    value={draft}
                    placeholder={`Reply to ${person(open.reporterId).name}`}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); }}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" className="btn sm primary" disabled={!draft.trim()}>Send reply</button>
                    <button type="button" className="btn sm ghost" onClick={() => { setReplying(false); setDraft(''); }}>Cancel</button>
                  </div>
                </form>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn sm" onClick={() => setReplying(true)}>Reply</button>
                  <button type="button" className="btn sm">Merge into…</button>
                </div>
              )}
            </div>
          </>
        )}
      </Drawer>
    </>
  );
}

function FlowArrow() {
  return <li className="flow-arrow" aria-hidden="true"><Icon name="arrow" size={16} /></li>;
}
