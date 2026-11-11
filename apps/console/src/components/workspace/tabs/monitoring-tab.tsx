'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { createMockApi } from '@/lib/api/mock';
import { AGENTS_NODE, IDENTITY_NODE, type AppMetrics, type AppSummary, type Grant, type MetricsRange, type RecentAction } from '@/lib/api/types';
import { formatDay, formatHour } from '@/lib/format';
import { Icon, ProtoTag, Seg } from '../../ui';

const RANGES = [
  { value: '24h', label: '24h' },
  { value: '14d', label: '14d' },
  { value: '30d', label: '30d' },
] as const satisfies readonly { value: MetricsRange; label: string }[];

const ACTIONS_COLOR = '#4f6bff';
const ERRORS_COLOR = '#d64545';

interface Loaded {
  range: MetricsRange;
  metrics: AppMetrics | null;
}

export default function MonitoringTab({ app }: { app: AppSummary }) {
  const [range, setRange] = useState<MetricsRange>('14d');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [names, setNames] = useState<Record<string, string>>({ [app.id]: app.name });

  useEffect(() => {
    let stale = false;
    const api = createMockApi();
    void Promise.all([api.listGrants(), api.listApps()]).then(([g, apps]) => {
      if (stale) return;
      setGrants(g.filter((l) => l.from === app.id || l.to === app.id));
      setNames(Object.fromEntries(apps.map((a) => [a.id, a.name])));
    });
    return () => {
      stale = true;
    };
  }, [app.id]);

  useEffect(() => {
    let stale = false;
    void createMockApi()
      .getMetrics(app.id, range)
      .then((metrics) => {
        if (!stale) setLoaded({ range, metrics });
      });
    return () => {
      stale = true;
    };
  }, [app.id, range]);

  const nodeName = (id: string) => (id === AGENTS_NODE ? 'Personal agents' : id === IDENTITY_NODE ? 'Kelay ID' : (names[id] ?? id));
  const metrics = loaded?.metrics ?? null;

  return (
    <>
      <div className="toolbar">
        <Seg label="Time range" options={RANGES} value={range} onChange={setRange} />
        {metrics &&
          (metrics.healthy ? (
            <span className="pill green"><span className="dot" />All systems normal</span>
          ) : (
            <span className="pill amber"><span className="dot" />Needs attention</span>
          ))}
      </div>

      {metrics ? (
        <div className="kpis" aria-busy={loaded?.range !== range}>
          <Kpi label="Active members (7d)" value={`${metrics.activeMembers.value} / ${metrics.activeMembers.total}`}>
            <Delta value={metrics.activeMembers.delta} />
          </Kpi>
          <Kpi label="Actions today" value={metrics.actionsToday.value.toLocaleString('en')}>
            <Delta value={metrics.actionsToday.deltaPct} suffix="%" />
          </Kpi>
          <Kpi label="Screen errors (7d)" value={String(metrics.screenErrors7d.value)}>
            <div className="delta muted">{metrics.screenErrors7d.note ?? 'None reached members'}</div>
          </Kpi>
          <Kpi label="Agent actions today" value={metrics.agentActionsToday.toLocaleString('en')}>
            <div className="delta muted">via members’ AI assistants</div>
          </Kpi>
          <Kpi label="App LLM budget today" value={`$${metrics.llmBudgetTodayUsd.toFixed(2)}`}>
            <div className="delta muted">assistant model cost is on members</div>
          </Kpi>
        </div>
      ) : null}

      <div className="two">
        <section className="card" aria-labelledby="mon-chart-title">
          <div className="card-head">
            <h3 id="mon-chart-title">Actions &amp; errors</h3>
            <span className="spacer" />
            <span className="small muted">
              <span style={{ color: ACTIONS_COLOR }} aria-hidden="true">━</span> Actions &nbsp;{' '}
              <span style={{ color: ERRORS_COLOR }} aria-hidden="true">┅</span> Errors
            </span>
          </div>
          {metrics ? (
            <div style={{ padding: 12 }}>
              <LineChart series={metrics.series} range={metrics.range} />
            </div>
          ) : (
            <div className="empty">{loaded ? 'No activity yet. Actions and errors show up here once people use the app.' : 'Loading…'}</div>
          )}
        </section>

        <section className="card" aria-labelledby="mon-conn-title">
          <div className="card-head">
            <h3 id="mon-conn-title">Connections</h3>
            <span className="muted small">{grants.length}</span>
            <span className="spacer" />
            <Link className="btn sm" href={`/graph/${app.id}`}><Icon name="share" size={13} /> Open app graph</Link>
          </div>
          {grants.length ? (
            grants.map((l) => (
              <Link className="conn-row" href={`/graph/${l.id}`} key={l.id}>
                <ProtoTag kind={l.kind} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{nodeName(l.from)} → {nodeName(l.to)}</div>
                  <div className="what">{l.what}</div>
                </div>
                {l.status === 'pending' ? (
                  <span className="pill amber">Pending</span>
                ) : l.status === 'paused' ? (
                  <span className="pill">Paused</span>
                ) : (
                  <span className="small muted">{l.callsPerDay}/day</span>
                )}
              </Link>
            ))
          ) : (
            <div className="node-detail muted">Not connected to other apps yet.</div>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="mon-recent-title">
        <div className="card-head"><h3 id="mon-recent-title">Recent actions</h3></div>
        {metrics && metrics.recent.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th scope="col">Action</th><th scope="col">By</th><th scope="col">Status</th><th scope="col">Time</th><th scope="col">Called from</th></tr>
              </thead>
              <tbody>
                {metrics.recent.map((r) => (
                  <tr key={r.id}>
                    <td>{r.action}</td>
                    <td>{r.by}</td>
                    <td><ActionStatus status={r.status} /></td>
                    <td>{r.ms}ms</td>
                    <td>{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">{loaded ? 'No actions yet.' : 'Loading…'}</div>
        )}
      </section>
    </>
  );
}

function Kpi({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="val">{value}</div>
      {children}
    </div>
  );
}

function Delta({ value, suffix = '' }: { value: number; suffix?: string }) {
  if (value === 0) return <div className="delta muted">No change</div>;
  const up = value > 0;
  return (
    <div className={`delta ${up ? 'up' : 'down'}`}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      <span className="sr-only">{up ? 'Up' : 'Down'}</span> {Math.abs(value)}{suffix}
    </div>
  );
}

function ActionStatus({ status }: { status: RecentAction['status'] }) {
  if (status === 'ok') return <span className="pill green">ok</span>;
  if (status === 'blocked') return <span className="pill amber">blocked by rule</span>;
  return <span className="pill red">error</span>;
}

/** 1, 2 or 5 times a power of ten, at or below `v`. */
function niceStep(v: number): number {
  if (v <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  return (f < 2 ? 1 : f < 5 ? 2 : 5) * pow;
}

const W = 640;
const H = 200;
const P = 28;

function LineChart({ series, range }: { series: AppMetrics['series']; range: MetricsRange }) {
  const { buckets, actions, errors } = series;
  const n = actions.length;
  if (n === 0) return <div className="empty">No data for this range.</div>;

  const peak = Math.max(1, ...actions, ...errors);
  const step = niceStep(peak / 2);
  const max = Math.max(peak * 1.15, step * 2.5);
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);

  const x = (i: number) => (n === 1 ? W / 2 : P + (i * (W - P * 2)) / (n - 1));
  const y = (v: number) => H - P - (v / max) * (H - P * 2);
  const path = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const bucketLabel = (iso: string) => (range === '24h' ? formatHour(iso) : formatDay(iso));
  const every = Math.ceil(n / 5);
  const band = (W - P * 2) / n;
  const totalActions = actions.reduce((s, v) => s + v, 0);
  const totalErrors = errors.reduce((s, v) => s + v, 0);
  const first = buckets[0];
  const last = buckets[n - 1];
  const summary =
    `Actions and errors per ${range === '24h' ? 'hour' : 'day'}` +
    (first && last ? `, ${bucketLabel(first)} to ${bucketLabel(last)}` : '') +
    `: ${totalActions.toLocaleString('en')} actions, peak ${Math.max(...actions)}; ${totalErrors} error${totalErrors === 1 ? '' : 's'}.`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={summary}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={P} x2={W - P} y1={y(v)} y2={y(v)} stroke="#eeece6" />
          <text x={P - 6} y={y(v) + 4} fontSize="10" fill="#a3a19a" textAnchor="end">{v}</text>
        </g>
      ))}
      {buckets.map((b, i) =>
        i % every === 1 % every ? (
          <text key={b} x={x(i)} y={H - 8} fontSize="10" fill="#a3a19a" textAnchor="middle">{bucketLabel(b)}</text>
        ) : null,
      )}
      <path d={`${path(actions)} L${x(n - 1)},${y(0)} L${x(0)},${y(0)}Z`} fill={ACTIONS_COLOR} opacity=".07" />
      <path d={path(actions)} fill="none" stroke={ACTIONS_COLOR} strokeWidth="2" />
      <path d={path(errors)} fill="none" stroke={ERRORS_COLOR} strokeWidth="2" strokeDasharray="4 3" />
      {buckets.map((b, i) => (
        <rect key={b} x={x(i) - band / 2} y={P / 2} width={band} height={H - P * 1.5} fill="transparent">
          <title>{`${bucketLabel(b)}: ${actions[i] ?? 0} actions, ${errors[i] ?? 0} errors`}</title>
        </rect>
      ))}
    </svg>
  );
}
