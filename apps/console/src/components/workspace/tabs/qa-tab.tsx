'use client';

import { useEffect, useRef, useState } from 'react';
import { QA } from '@/lib/api/fixtures';
import type { AppDetail, QaCheck, QaSummary } from '@/lib/api/types';
import type { IconName } from '../../icon-paths';
import { useToast } from '../../toast';
import { Icon, RichText } from '../../ui';

const STATUS_ICON: Record<QaCheck['status'], IconName> = { ok: 'check', bad: 'x', wait: 'dots' };
const STATUS_LABEL: Record<QaCheck['status'], string> = { ok: 'Passed', bad: 'Failed', wait: 'Waiting' };
const STEP_MS = 140;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export default function QaTab({
  app,
  qa: qaProp,
}: {
  app: AppDetail;
  /** Defaults to the mock summary for the app. */
  qa?: QaSummary | null;
}) {
  const notify = useToast();
  const qa = qaProp === undefined ? (QA[app.id] ?? null) : qaProp;
  // Number of checks finished in the current run; null when no run is in progress.
  const [progress, setProgress] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => () => clearInterval(timer.current), []);

  if (!qa) {
    return (
      <div className="card">
        <div className="empty">No interaction checks yet. They are generated from the screens on the first deploy.</div>
      </div>
    );
  }

  const { checks, passing, total } = qa;
  const running = progress !== null;
  const clean = qa.errorsReachedUsers7d === 0;
  const more = total - checks.length;

  function runAll() {
    if (running) return;
    setProgress(0);
    let done = 0;
    timer.current = setInterval(() => {
      done += 1;
      if (done >= checks.length) {
        clearInterval(timer.current);
        setProgress(null);
        notify(`${passing} of ${total} checks passed`);
      } else {
        setProgress(done);
      }
    }, STEP_MS);
  }

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
          <span className="muted">{total} interaction checks run before every deploy.</span>
        </span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={runAll} disabled={running}>
          <Icon name="refresh" size={13} /> {running ? 'Running checks…' : 'Run all checks'}
        </button>
      </div>
      <div className="two">
        <section className="card" aria-label="Interaction checks">
          <div className="card-head">
            <h3>Interaction checks</h3>
            <span className="muted small">auto-generated from the screens</span>
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
                      <div className="when">{t.when}</div>
                      <RichText text={t.text} />
                    </li>
                  ))}
                </ol>
              </div>
            </section>
          ))}
          {qa.incidents.length === 0 && (
            <div className="card"><div className="empty">No errors caught in the last 7 days.</div></div>
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
