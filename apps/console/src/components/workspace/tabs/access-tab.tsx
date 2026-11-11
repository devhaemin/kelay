'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useId, useState, useTransition, type FormEvent } from 'react';
import { deployAction, savePolicyAction } from '@/app/actions';
import type { AccessPreview, AccessSample, AppDetail, AppPolicy, Op, PolicyMatrix, Scope } from '@/lib/api/types';
import type { TabMember } from '@/lib/api/workspace-fixtures';
import { firstName, formatDay, formatTime } from '@/lib/format';
import { OPS, collectionNoun, ownerField, policySql, roleLabel, roleName, ruleKey, rulesFor, scopeOf, scopePhrase, verbs, withScope, type CollectionDef, type RuleRow } from '@/lib/policy';
import { useServerState } from '@/lib/use-server-state';
import { useToast } from '../../toast';
import { Avatar, Icon, Seg, Switch } from '../../ui';
import { PolicyMatrixCard } from '../policy-matrix-card';

const SCOPE_LABEL: Record<Exclude<Scope, 'none'>, string> = { all: 'All rows', mine_shared: 'Own + shared', mine: 'Own rows' };

const scopesFor = (c: CollectionDef): Exclude<Scope, 'none'>[] => (c.shared ? ['all', 'mine_shared', 'mine'] : ['all', 'mine']);

/** A rule switched off in this visit: its ops are `none` in the matrix, and the row stays so it can be switched back on. */
interface OffRule extends RuleRow {
  collection: string;
}

const sentence = (c: CollectionDef, r: RuleRow) => `${roleLabel(r.role)} can ${verbs(r.ops)} ${scopePhrase(c, r.scope, r.ops)}`;

/** Row ids are UUIDs in a real app database; the tail is enough to tell rows apart. */
const shortId = (id: string) => (id.length > 12 ? `…${id.slice(-6)}` : id);

function rowTag(c: CollectionDef, row: AccessSample, userId: string): string | null {
  if (row.ownerId === userId) return ownerField(c) === 'assignee_id' ? 'Assigned' : 'Owner';
  if (row.createdBy === userId) return 'Created';
  return row.shared ? 'Shared' : null;
}

export default function AccessTab({
  app,
  policy: policyProp,
  viewers,
  previews,
}: {
  app: AppDetail;
  /** Null until a version with a schema is deployed to Development. */
  policy: AppPolicy | null;
  /** People "Preview as" can pick from. */
  viewers: TabMember[];
  /** What each viewer can see and do, evaluated on the server. */
  previews: AccessPreview[];
}) {
  const notify = useToast();
  const formId = useId();
  const [policy, setPolicy] = useServerState(policyProp);
  const [collection, setCollection] = useState(policyProp?.schema.collections[0]?.name ?? '');
  const [off, setOff] = useState<OffRule[]>([]);
  const [shownPolicy, setShownPolicy] = useState<string | null>(null);
  const [previewAs, setPreviewAs] = useState(viewers[0]?.userId ?? '');
  const [adding, setAdding] = useState(false);
  const [draftRole, setDraftRole] = useState('');
  const [draftOp, setDraftOp] = useState<Op>('read');
  const [draftScope, setDraftScope] = useState<Exclude<Scope, 'none'>>('all');
  const [busy, startBusy] = useTransition();

  const def = policy?.schema.collections.find((c) => c.name === collection) ?? policy?.schema.collections[0];
  if (!policy || !def) {
    return (
      <div className="card">
        <div className="empty">
          <b>No access rules yet</b>
          <div>Rules come from the app’s data schema. They show up here after the first deploy to Development.</div>
        </div>
      </div>
    );
  }

  const { schema, matrix } = policy;
  const on = rulesFor(schema, matrix, def.name);
  // An off rule drops out once its ops have a scope again (switched back on, or covered by another rule).
  const stillOff = off.filter((r) => r.collection === def.name && r.ops.every((op) => scopeOf(matrix, r.role, def.name, op) === 'none'));
  const shown: (RuleRow & { off: boolean })[] = [...on.map((r) => ({ ...r, off: false })), ...stillOff.map((r) => ({ ...r, off: true }))];
  const noteFor = (r: RuleRow) => policy.notes.find((n) => n.collection === def.name && n.role === r.role && r.ops.includes(n.op))?.from ?? null;
  const warnings = stillOff.filter((r) => noteFor(r));

  const viewer = viewers.find((m) => m.userId === previewAs) ?? viewers[0];
  const preview = viewer ? previews.find((p) => p.userId === viewer.userId) : undefined;
  const seen = preview?.collections.find((c) => c.collection === def.name);
  const noun = collectionNoun(def);

  /** Saves the whole matrix; the answer carries the draft the rules were stored as. */
  async function save(next: PolicyMatrix, message: string): Promise<boolean> {
    const res = await savePolicyAction(app.id, next);
    if (!res.ok) {
      notify(res.error);
      return false;
    }
    setPolicy(res.data);
    notify(message);
    return true;
  }

  function toggleRule(r: RuleRow, turnOn: boolean) {
    startBusy(async () => {
      const key = `${def!.name}:${r.key}`;
      if (turnOn) {
        if (await save(withScope(matrix, r.role, def!.name, r.ops, r.scope), 'Rule switched on')) setOff((prev) => prev.filter((x) => `${x.collection}:${x.key}` !== key));
      } else if (await save(withScope(matrix, r.role, def!.name, r.ops, 'none'), 'Rule switched off')) {
        setOff((prev) => [...prev.filter((x) => `${x.collection}:${x.key}` !== key), { ...r, collection: def!.name }]);
      }
    });
  }

  function changeScope(r: RuleRow, scope: Scope) {
    startBusy(async () => {
      await save(withScope(matrix, r.role, def!.name, r.ops, scope), 'Rule updated');
    });
  }

  function addRule(e: FormEvent) {
    e.preventDefault();
    const role = draftRole || schema.roles[0];
    if (!role) return;
    const scope = draftScope === 'mine_shared' && !def!.shared ? 'mine' : draftScope;
    startBusy(async () => {
      if (await save(withScope(matrix, role, def!.name, [draftOp], scope), `Rule saved for ${def!.name}`)) {
        setShownPolicy(ruleKey(role, scope));
        setAdding(false);
      }
    });
  }

  function deployDraft() {
    startBusy(async () => {
      const res = await deployAction(app.id, 'dev');
      if (!res.ok) return notify(res.error);
      setOff([]);
      notify(`Rules are live in Development (${res.data.version})`);
    });
  }

  return (
    <>
      {policy.draft && (
        <div className="banner" role="status" style={{ background: 'var(--amber-soft)', borderColor: '#f3dcb0' }}>
          <Icon name="alert" size={15} />
          <span>
            <b>Draft {policy.draft.version} · not live yet.</b>{' '}
            <span className="muted">
              Saved {formatDay(policy.draft.savedAt)} at {formatTime(policy.draft.savedAt)}.{' '}
              {policy.version ? `Members keep the ${policy.version} rules until you deploy.` : 'The rules go live when you deploy.'}
            </span>
          </span>
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={busy} onClick={deployDraft}>
            <Icon name="rocket" size={13} /> Deploy to Development
          </button>
        </div>
      )}
      {warnings.map((r) => (
        <div className="banner" key={r.key} role="status" style={{ background: 'var(--amber-soft)', borderColor: '#f3dcb0' }}>
          <Icon name="alert" size={15} />{' '}
          <span><b>“{sentence(def, r)}” is switched off.</b> <span className="muted">People asked for it in {noteFor(r)}.</span></span>
        </div>
      ))}
      <div className="toolbar">
        {schema.collections.length > 0 && (
          <Seg label="Collection" value={def.name} onChange={setCollection} options={schema.collections.map((c) => ({ value: c.name, label: c.name }))} />
        )}
        <span className="small muted">Rules apply to the app, its API and every agent that acts for a user.</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn sm" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
          <Icon name="plus" size={13} /> Add rule
        </button>
      </div>
      <div className="two">
        <section className="card" aria-label="Access rules" aria-busy={busy}>
          <div className="card-head">
            <h3>Who can see and do what</h3>
            <span className="muted small">{def.name} · {on.length} {on.length === 1 ? 'rule' : 'rules'}</span>
          </div>
          {adding && (
            <form className="rule" onSubmit={addRule}>
              <div className="sentence" style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', lineHeight: 1.5 }}>
                <label className="field">
                  Who
                  <select className="select sm" autoFocus value={draftRole || schema.roles[0]} onChange={(e) => setDraftRole(e.target.value)}>
                    {schema.roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                  </select>
                </label>
                <label className="field">
                  Can
                  <select className="select sm" value={draftOp} onChange={(e) => setDraftOp(e.target.value as Op)}>
                    {OPS.map((op) => <option key={op} value={op}>{verbs([op])}</option>)}
                  </select>
                </label>
                <label className="field">
                  Which {noun}
                  <select className="select sm" value={draftScope} onChange={(e) => setDraftScope(e.target.value as Exclude<Scope, 'none'>)}>
                    {scopesFor(def).map((s) => <option key={s} value={s}>{scopePhrase(def, s, [draftOp])}</option>)}
                  </select>
                </label>
              </div>
              <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-end' }}>
                <button type="button" className="btn sm ghost" onClick={() => setAdding(false)}>Cancel</button>
                <button type="submit" className="btn sm primary" disabled={busy}>Add</button>
              </div>
            </form>
          )}
          {shown.map((r) => {
            const open = shownPolicy === r.key;
            const policyId = `${formId}-policy-${r.key}`;
            const from = noteFor(r);
            const text = sentence(def, r);
            return (
              <div className={clsx('rule', r.off && 'off')} key={r.key}>
                <div className="sentence">
                  <span className="chip who">{roleLabel(r.role)}</span> can <b>{verbs(r.ops)}</b> <span className="chip">{scopePhrase(def, r.scope, r.ops)}</span>
                  {from && (
                    <span className="pill blue" style={{ marginLeft: 4 }}>
                      New · from <span className="ticket-ref" style={{ background: 'none', padding: 0 }}>{from}</span>
                    </span>
                  )}
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button type="button" className="linkish" aria-expanded={open} aria-controls={open ? policyId : undefined} onClick={() => setShownPolicy(open ? null : r.key)}>
                      {open ? 'Hide policy' : 'Show policy'}
                    </button>
                    {!r.off && (
                      <label className="small muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        Applies to
                        <select className="select sm" value={r.scope} disabled={busy} aria-label={`Rows “${text}” applies to`} onChange={(e) => changeScope(r, e.target.value as Scope)}>
                          {scopesFor(def).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  {open && (
                    <pre className="policy" id={policyId} style={{ marginBottom: 0 }} tabIndex={0}>
                      {r.ops.map((op) => policySql(def, r.role, op, r.off ? 'none' : r.scope)).join('\n\n')}
                    </pre>
                  )}
                </div>
                <Switch on={!r.off} disabled={busy} onChange={(next) => toggleRule(r, next)} label={text} />
              </div>
            );
          })}
          {shown.length === 0 && !adding && <div className="empty">No rules for {def.name} yet, so nobody can read or change them. Add one.</div>}
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
          {!viewer ? (
            <div className="empty">Invite people to preview what each of them can see.</div>
          ) : !seen ? (
            <div className="empty">Nothing to preview for {viewer.name}: {app.name} has no data in Development to read yet.</div>
          ) : (
            <>
              <div className="node-detail" style={{ paddingBottom: 6 }} aria-live="polite">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Avatar id={viewer.userId} name={viewer.name} color={viewer.color} size={30} />
                  <div>
                    <div><b>{viewer.name}</b> sees <b>{seen.readable}</b>{seen.total !== null && <> of {seen.total}</>} {noun}</div>
                    <div className="small muted">
                      Can edit {seen.editable} · delete {seen.deletable} · {seen.canCreate ? 'can create' : 'can’t create'}
                    </div>
                  </div>
                </div>
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {seen.rows.map((s) => {
                  const tag = rowTag(def, s, viewer.userId);
                  return (
                    <li className="vis-row" key={s.id}>
                      <span className="mono" title={s.id}>{shortId(s.id)}</span>
                      <span style={{ flex: 1 }}>{s.label}</span>
                      {tag && <span className="pill">{tag}</span>}
                      {s.canUpdate === false && <span className="pill">Read only</span>}
                    </li>
                  );
                })}
              </ul>
              <div className="node-detail" style={{ paddingTop: 10 }}>
                <div className="small muted">
                  <Icon name="cpu" size={13} /> {firstName(viewer.name)}’s AI assistant sees exactly the same {noun}.{' '}
                  <Link className="linkish" href={`/app/${app.id}/agent`}>Agent →</Link>
                </div>
                {preview?.version && policy.draft && (
                  <div className="small muted" style={{ marginTop: 6 }}>
                    The preview reads the database with the deployed rules ({preview.version}), not the draft.
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>
      <PolicyMatrixCard policy={policy} />
    </>
  );
}
