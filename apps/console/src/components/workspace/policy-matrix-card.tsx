'use client';

import { useId, useState } from 'react';
import type { AppPolicy, Scope } from '@/lib/api/types';
import { OPS, policySql, roleLabel, scopeOf, verbs } from '@/lib/policy';
import { Seg } from '../ui';

const SCOPE: Record<Scope, { label: string; className: string }> = {
  all: { label: 'All', className: 'pill green' },
  mine_shared: { label: 'Own + shared', className: 'pill blue' },
  mine: { label: 'Own', className: 'pill amber' },
  none: { label: 'None', className: 'pill' },
};

/** The app's PolicyMatrix (contracts §3) for one collection, and the RLS policies it installs. */
export function PolicyMatrixCard({ policy }: { policy: AppPolicy }) {
  const { schema, matrix } = policy;
  const [collection, setCollection] = useState(schema.collections[0]?.name ?? '');
  const [showSql, setShowSql] = useState(false);
  const headingId = useId();
  const def = schema.collections.find((c) => c.name === collection);
  if (!def) return null;
  const sql = schema.roles
    .flatMap((role) => OPS.filter((op) => scopeOf(matrix, role, collection, op) !== 'none').map((op) => policySql(def, role, op, scopeOf(matrix, role, collection, op))))
    .join('\n\n');

  return (
    <section className="card" style={{ marginTop: 16 }} aria-labelledby={headingId}>
      <div className="card-head">
        <h3 id={headingId}>Policy matrix</h3>
        <span className="muted small">role × operation → scope · compiled to Postgres RLS</span>
        <span className="spacer" />
        <Seg label="Collection" value={collection} onChange={setCollection} options={schema.collections.map((c) => ({ value: c.name, label: c.name }))} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Role</th>{OPS.map((op) => <th key={op} scope="col">{verbs([op])}</th>)}</tr>
          </thead>
          <tbody>
            {schema.roles.map((role) => (
              <tr key={role}>
                <th scope="row" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{roleLabel(role)}</th>
                {OPS.map((op) => {
                  const s = SCOPE[scopeOf(matrix, role, collection, op)];
                  return <td key={op}><span className={s.className}>{s.label}</span></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="node-detail">
        <div className="small muted">
          Own means {def.ownerField ?? 'owner_id'} is the signed-in member{def.shared ? '; shared rows are visible to everyone with Own + shared' : ''}. Every policy also requires the member’s org.
        </div>
        <div><button type="button" className="linkish" aria-expanded={showSql} onClick={() => setShowSql(!showSql)}>{showSql ? 'Hide policy SQL' : 'Show policy SQL'}</button></div>
        {showSql && <div className="policy" style={{ marginTop: 0 }}>{sql || '-- no policies: every operation is denied'}</div>}
      </div>
    </section>
  );
}
