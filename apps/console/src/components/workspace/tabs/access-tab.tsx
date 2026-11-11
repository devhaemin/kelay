'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import type { AccessSample, AppDetail } from '@/lib/api/types';
import {
  ACCESS_COLLECTIONS,
  ACCESS_RULES,
  fixtureMembers,
  fixtureSamples,
  type AccessRule,
  type TabMember,
} from '@/lib/api/workspace-fixtures';
import { firstName } from '@/lib/format';
import { roleName } from '@/lib/policy';
import { useToast } from '../../toast';
import { Avatar, Icon, Seg, Switch } from '../../ui';

const SQL_OP: Record<string, string> = {
  view: 'select', see: 'select', read: 'select',
  create: 'insert', add: 'insert',
  delete: 'delete', remove: 'delete',
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Reads "Guests can view tickets shared with them" into a rule; null when the sentence has no "can". */
function parseRule(sentence: string, collection: string, id: string): AccessRule | null {
  const m = /^(.+?)\s+can\s+(\S+)\s+(.+?)\.?$/i.exec(sentence.trim());
  if (!m) return null;
  const [, who = '', verbRaw = '', what = ''] = m;
  const verb = verbRaw.toLowerCase();
  const op = SQL_OP[verb] ?? 'update';
  const role = slug(who).replace(/s$/, '');
  const clause = op === 'insert' ? 'with check' : 'using';
  return {
    id,
    collection,
    who: who.charAt(0).toUpperCase() + who.slice(1),
    verb,
    what,
    sql: `create policy "${slug(`${who} ${verb} ${collection}`)}"\non ${collection} for ${op}\n${clause} (team_role(auth.uid()) = '${role}');`,
  };
}

export default function AccessTab({
  app,
  members: membersProp,
  samples: samplesProp,
}: {
  app: AppDetail;
  /** People "Preview as" can pick from; defaults to the mock team. */
  members?: TabMember[];
  /** Rows the preview evaluates the rules against; defaults to the mock board. */
  samples?: AccessSample[];
}) {
  const notify = useToast();
  const formId = useId();
  const members = membersProp ?? fixtureMembers(app.id);
  const samples = samplesProp ?? fixtureSamples(app.id);
  const viewers = [members.find((m) => m.role !== 'admin'), members.find((m) => m.role === 'admin')].filter((m): m is TabMember => !!m);

  const [rules, setRules] = useState<AccessRule[]>(() => ACCESS_RULES[app.id] ?? []);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [shownPolicy, setShownPolicy] = useState<string | null>(() => ACCESS_RULES[app.id]?.[0]?.id ?? null);
  const [previewAs, setPreviewAs] = useState<string>(viewers[0]?.userId ?? '');
  const collections = ACCESS_COLLECTIONS[app.id] ?? [...new Set(rules.map((r) => r.collection))];
  const [collection, setCollection] = useState<string>(collections[0] ?? 'records');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState(false);

  const isOn = (id: string) => !off.has(id);
  const shown = rules.filter((r) => r.collection === collection);
  const warnings = rules.filter((r) => r.offWarning && !isOn(r.id));

  const viewer = viewers.find((m) => m.userId === previewAs) ?? viewers[0];
  const previewNoun = rules.find((r) => r.preview)?.collection ?? 'rows';
  const ownOn = rules.some((r) => r.preview === 'own' && isOn(r.id));
  const adminAllOn = rules.some((r) => r.preview === 'admin_all' && isOn(r.id));
  const visible = !viewer
    ? []
    : (viewer.role === 'admin' && adminAllOn) || !ownOn
      ? samples
      : samples.filter((s) => s.ownerId === viewer.userId || s.createdBy === viewer.userId);

  function toggleRule(id: string, on: boolean) {
    setOff((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addRule(e: FormEvent) {
    e.preventDefault();
    const rule = parseRule(draft, collection, `new-${rules.length + 1}`);
    if (!rule) {
      setDraftError(true);
      return;
    }
    setRules((prev) => [...prev, rule]);
    setAdded((prev) => new Set(prev).add(rule.id));
    setShownPolicy(rule.id);
    setDraft('');
    setDraftError(false);
    setAdding(false);
    notify(`Rule added to ${collection}`);
  }

  return (
    <>
      {warnings.map((r) => (
        <div className="banner" key={r.id} role="status" style={{ background: 'var(--amber-soft)', borderColor: '#f3dcb0' }}>
          <Icon name="alert" size={15} />{' '}
          <span><b>{r.offWarning?.title}</b> <span className="muted">{r.offWarning?.detail}</span></span>
        </div>
      ))}
      <div className="toolbar">
        {collections.length > 0 && (
          <Seg label="Collection" value={collection} onChange={setCollection} options={collections.map((c) => ({ value: c, label: c }))} />
        )}
        <span className="small muted">Rules apply to the app, its API and every agent that acts for a user.</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn sm" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
          <Icon name="plus" size={13} /> Add rule
        </button>
      </div>
      <div className="two">
        <section className="card" aria-label="Access rules">
          <div className="card-head">
            <h3>Who can see and do what</h3>
            <span className="muted small">{collection} · {shown.length} {shown.length === 1 ? 'rule' : 'rules'}</span>
          </div>
          {adding && (
            <form className="rule" onSubmit={addRule} noValidate>
              <div className="sentence" style={{ lineHeight: 1.5 }}>
                <label className="field">
                  Describe the rule in plain words
                  <input
                    className="input"
                    autoFocus
                    value={draft}
                    onChange={(e) => { setDraft(e.target.value); setDraftError(false); }}
                    placeholder={`Guests can view ${collection} shared with them`}
                    aria-invalid={draftError}
                    aria-describedby={draftError ? `${formId}-err` : undefined}
                  />
                </label>
                {draftError && (
                  <div className="error-text" id={`${formId}-err`} role="alert" style={{ marginTop: 6 }}>
                    Write it as “Who can do what”, like “Guests can view {collection} shared with them”.
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-end' }}>
                <button type="button" className="btn sm ghost" onClick={() => { setAdding(false); setDraftError(false); }}>Cancel</button>
                <button type="submit" className="btn sm primary" disabled={!draft.trim()}>Add</button>
              </div>
            </form>
          )}
          {shown.map((r) => {
            const open = shownPolicy === r.id;
            const policyId = `${formId}-policy-${r.id}`;
            return (
              <div className={clsx('rule', !isOn(r.id) && 'off')} key={r.id}>
                <div className="sentence">
                  <span className="chip who">{r.who}</span> can <b>{r.verb}</b> <span className="chip">{r.what}</span>
                  {(r.from || added.has(r.id)) && (
                    <span className="pill blue" style={{ marginLeft: 4 }}>
                      New{r.from && <> · from <span className="ticket-ref" style={{ background: 'none', padding: 0 }}>{r.from}</span></>}
                    </span>
                  )}
                  <div>
                    <button type="button" className="linkish" aria-expanded={open} aria-controls={open ? policyId : undefined} onClick={() => setShownPolicy(open ? null : r.id)}>
                      {open ? 'Hide policy' : 'Show policy'}
                    </button>
                  </div>
                  {open && <pre className="policy" id={policyId} style={{ marginBottom: 0 }} tabIndex={0}>{r.sql}</pre>}
                </div>
                <Switch on={isOn(r.id)} onChange={(on) => toggleRule(r.id, on)} label={`${r.who} can ${r.verb} ${r.what}`} />
              </div>
            );
          })}
          {shown.length === 0 && !adding && <div className="empty">No rules for {collection} yet. Add one in plain words.</div>}
        </section>
        <section className="card" aria-label="Preview as">
          <div className="card-head">
            <h3><Icon name="eye" size={15} /> Preview as</h3>
            <span className="spacer" />
            {viewers.length > 0 && (
              <Seg
                label="Preview as"
                value={viewer?.userId ?? ''}
                onChange={setPreviewAs}
                options={viewers.map((m) => ({ value: m.userId, label: `${firstName(m.name)} · ${roleName(m.role)}` }))}
              />
            )}
          </div>
          {viewer ? (
            <>
              <div className="node-detail" style={{ paddingBottom: 6 }} aria-live="polite">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Avatar id={viewer.userId} name={viewer.name} color={viewer.color} size={30} />
                  <div><b>{viewer.name}</b> sees <b>{visible.length}</b> of {samples.length} {previewNoun}</div>
                </div>
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {visible.map((s) => (
                  <li className="vis-row" key={s.id}>
                    <span className="mono">{s.id}</span>
                    <span style={{ flex: 1 }}>{s.label}</span>
                    {s.ownerId === viewer.userId ? <span className="pill">Assigned</span> : s.createdBy === viewer.userId ? <span className="pill">Created</span> : null}
                  </li>
                ))}
              </ul>
              <div className="node-detail" style={{ paddingTop: 10 }}>
                <div className="small muted">
                  <Icon name="cpu" size={13} /> {firstName(viewer.name)}’s AI assistant sees exactly the same {previewNoun}.{' '}
                  <Link className="linkish" href={`/app/${app.id}/agent`}>Agent →</Link>
                </div>
              </div>
            </>
          ) : (
            <div className="empty">Invite people to preview what each of them can see.</div>
          )}
        </section>
      </div>
    </>
  );
}
