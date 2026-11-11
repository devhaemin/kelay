'use client';

import { useEffect, useRef, useState } from 'react';
import { runQaAction } from '@/app/actions';
import type { AppDetail, QaCheck, QaSummary } from '@/lib/api/types';
import { formatDay, formatTime } from '@/lib/format';
import { useServerState } from '@/lib/use-server-state';
import type { IconName } from '../../icon-paths';
import { useToast } from '../../toast';
import { Icon, RichText } from '../../ui';

const STATUS_ICON: Record<QaCheck['status'], IconName> = { ok: 'check', bad: 'x', wait: 'dots' };
const STATUS_LABEL: Record<QaCheck['status'], string> = { ok: 'Passed', bad: 'Failed', wait: 'Waiting' };
const STEP_MS = 140;
/** Longest the results of one run take to tick in, however many checks it has. */
const REVEAL_MS = 2400;

const seconds = (ms: number) => (ms < 100 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
/** Timeline entries carry an ISO timestamp from the API, or ready-made text from fixtures. */
const when = (v: string) => (/^\d{4}-\d{2}-\d{2}T/.test(v) ? `${formatDay(v)} · ${formatTime(v)}` : v);

export default function QaTab({
  app,
  qa: qaProp,
}: {
  app: AppDetail;
  /** The latest run; null before the first one. */
  qa: QaSummary | null;
}) {
  const notify = useToast();
  const [qa, setQa] = useServerState(qaProp);
  // Number of checks shown as finished in the current run; null when no run is in progress.
  const [progress, setProgress] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => () => clearInterval(timer.current), []);
  const running = progress !== null;

  async function runAll() {
    if (running) return;
    setProgress(0);
    const res = await runQaAction(app.id);
    if (!res.ok) {
      setProgress(null);
      notify(res.error);
      return;
    }
    const next = res.data;
    setQa(next);
    const finish = () => {
      clearInterval(timer.current);
      setProgress(null);
      notify(next.error ? 'The checks could not run' : `${next.passing} of ${next.total} checks passed`);
    };
    if (next.checks.length === 0) return finish();
    let done = 0;
    timer.current = setInterval(() => {
      done += 1;
      if (done >= next.checks.length) finish();
      else setProgress(done);
    }, Math.min(STEP_MS, REVEAL_MS / next.checks.length));
  }

  if (!qa) {
    return (
      <div className="card">
        <div className="empty">
          <b>No checks have run yet</b>
          <div>Checks are generated from the app’s screens and access rules. Run them once to see the results here.</div>
          <button type="button" className="btn sm primary" style={{ marginTop: 12 }} onClick={runAll} disabled={running}>
            <Icon name="refresh" size={13} /> {running ? 'Running checks…' : 'Run all checks'}
          </button>
        </div>
      </div>
    );
  }

  const { checks, passing, total } = qa;
  const clean = qa.errorsReachedUsers7d === 0;
  const more = total - checks.length;
  const fromRules = checks.some((c) => c.role);

  return (
    <>
      <div
        className="banner"
        style={clean ? { background: 'var(--green-soft)', borderColor: '#c8ead5' } : { background: 'var(--red-soft)', borderColor: '#f3c9c9' }}
      >
        <span className={`st-ic ${clean ? 'ok' : 'bad'}`}><Icon name={clean ? 'check' : 'alert'} size={12} /></span>
        <span>
          <b>
            {clean
              ? 'No screen errors reached users in the last 7 days.'
              : `${qa.errorsReachedUsers7d} screen ${qa.errorsReachedUsers7d === 1 ? 'error' : 'errors'} reached users in the last 7 days.`}
          </b>{' '}
          <span className="muted">
            {total} interaction checks run before every deploy.
            {qa.finishedAt && <> Last run {formatDay(qa.finishedAt)} at {formatTime(qa.finishedAt)}{qa.version ? ` on ${qa.version}` : ''}.</>}
          </span>
        </span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={runAll} disabled={running}>
          <Icon name="refresh" size={13} /> {running ? 'Running checks…' : 'Run all checks'}
        </button>
      </div>
      {qa.error && (
        <div className="banner" role="alert" style={{ background: 'var(--red-soft)', borderColor: '#f3c9c9' }}>
          <span className="st-ic bad"><Icon name="alert" size={12} /></span>
          <span><b>The last run could not finish.</b> <span className="muted">{qa.error}</span></span>
        </div>
      )}
      <div className="two">
        <section className="card" aria-label="Interaction checks">
          <div className="card-head">
            <h3>Interaction checks</h3>
            <span className="muted small">{fromRules ? 'generated from the access rules' : 'auto-generated from the screens'}</span>
            <span className="spacer" />
            {running
              ? <span className="pill">Running…</span>
              : <span className={`pill ${passing === total ? 'green' : 'red'}`}>{passing} / {total} passing</span>}
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {checks.map((c, i) => {
              const status = progress !== null && i >= progress ? 'wait' : c.status;
              return (
                <li className="check-row" key={c.name}>
                  <span className={`st-ic ${status}`}><Icon name={STATUS_ICON[status]} size={12} /></span>
                  <span className="sr-only">{STATUS_LABEL[status]}:</span>
                  <span style={{ flex: 1 }}>
                    {c.name}
                    {c.note && <> <span className="pill" style={{ marginLeft: 4 }}>{c.note}</span></>}
                  </span>
                  <span className="small muted">{status === 'wait' ? '—' : seconds(c.durationMs)}</span>
                </li>
              );
            })}
            {more > 0 && <li className="check-row muted small" style={{ justifyContent: 'center' }}>+ {more} more</li>}
          </ul>
        </section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          {qa.incidents.map((incident) => (
            <section className="card" key={incident.title} aria-label={incident.title}>
              <div className="card-head">
                <span className="st-ic bad"><Icon name="alert" size={12} /></span>
                <h3>{incident.title}</h3>
                <span className="spacer" />
                {incident.resolved ? <span className="pill green">Resolved</span> : <span className="pill red">Open</span>}
              </div>
              <div className="node-detail">
                <ol className="timeline" style={{ listStyle: 'none', margin: 0 }}>
                  {incident.timeline.map((t, i) => (
                    <li className={`tl ${t.tone ?? ''}`} key={i}>
                      <div className="when">{when(t.when)}</div>
                      <RichText text={t.text} />
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          ))}
          {qa.incidents.length === 0 && (
            <div className="card"><div className="empty">No errors caught lately.</div></div>
          )}
        </div>
      </div>
      <div className="section-head"><h2>How screens stay up</h2></div>
      <div className="three">
        <div className="mini-card"><b><Icon name="bolt" size={15} /> Typed actions</b><span className="muted">Every button and drag maps to an action checked against the data schema before it runs.</span></div>
        <div className="mini-card"><b><Icon name="undo" size={15} /> Safe fallbacks</b><span className="muted">If an action fails, the screen keeps its state and offers Retry instead of breaking.</span></div>
        <div className="mini-card"><b><Icon name="flask" size={15} /> Checks before deploy</b><span className="muted">Each interaction gets a check. A failing check blocks the deploy, not your users.</span></div>
      </div>
    </>
  );
}
