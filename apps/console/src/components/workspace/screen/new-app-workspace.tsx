'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '@/lib/action-result';
import type { AppSummary, ChatMessage, DeployResult } from '@/lib/api/types';
import { buildPlan } from '@/lib/build';
import { agentLabel, threadFromEvents, turnsOf, type BuilderEvent, type BuilderSession } from '@/lib/builder';
import { useBuilderEvents } from '@/lib/use-builder-events';
import { Icon } from '../../ui';
import { ChatPanel } from '../chat-panel';
import { WorkspaceShell } from '../workspace-shell';

const STEP_MS = 800;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StageStep {
  key: string;
  text: string;
  state: 'done' | 'running' | 'waiting' | 'failed';
}

/** The Building stage of `/app/new/screen`: the steps so far, then the way into the app. */
function BuildStage({
  app,
  done,
  error,
  detail,
  note,
  steps,
  messages,
}: {
  app: AppSummary | null;
  done: boolean;
  error: string | null;
  detail: string;
  /** Said under the steps, e.g. which coding agent is building. */
  note?: string | null;
  steps: StageStep[];
  messages: ChatMessage[];
}) {
  const ready = done ? app : null;
  return (
    <WorkspaceShell
      app={{ id: ready ? ready.id : 'new', name: ready ? ready.name : 'Untitled app', emoji: ready ? ready.emoji : '✨', color: '#eef1ff', status: 'draft', detail: null }}
      tab="screen"
      pendingProposals={0}
      tabsDisabled={!ready}
      chat={<ChatPanel appName={ready ? ready.name : 'Untitled app'} context="Screen · Board" messages={messages} />}
    >
      <div className="stage" style={{ height: '100%', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', width: 380, maxWidth: '100%' }} aria-live="polite">
          <div className="agent-badge" style={{ width: 56, height: 56, margin: '0 auto 16px', borderRadius: 16 }} aria-hidden="true">
            <Icon name={ready ? 'check' : 'sparkle'} size={24} />
          </div>
          <h2 style={{ margin: '0 0 6px', fontSize: 17 }}>{error ? 'The build stopped' : ready ? `${ready.name} is ready` : 'Building your app…'}</h2>
          <p className="muted" style={{ margin: '0 0 20px', lineHeight: 1.5 }}>{error ?? detail}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left' }}>
            {steps.map((s) =>
              s.state === 'done' ? (
                <div key={s.key} className="step done"><Icon name="check" size={14} /> {s.text}</div>
              ) : s.state === 'running' ? (
                <div key={s.key} className="step"><span className="spinner" aria-hidden="true" /> {s.text}</div>
              ) : s.state === 'failed' ? (
                <div key={s.key} className="step"><Icon name="x" size={14} /> {s.text}</div>
              ) : (
                <div key={s.key} className="step" style={{ opacity: 0.5 }}><Icon name="chev" size={14} /> {s.text}</div>
              ),
            )}
          </div>
          {note && <p className="small muted" style={{ margin: '14px 0 0', lineHeight: 1.5 }}>{note}</p>}
          {ready && (
            <Link className="btn primary" style={{ marginTop: 20 }} href={`/app/${ready.id}/screen`}>
              Open {ready.name} <Icon name="arrow" size={14} />
            </Link>
          )}
          {error && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 20 }}>
              {app && <Link className="btn" href={`/app/${app.id}/screen`}>Open {app.name}</Link>}
              <Link className="btn" href="/">Back to Home</Link>
            </div>
          )}
        </div>
      </div>
    </WorkspaceShell>
  );
}

/**
 * `/app/new/screen`: creates the app from the Home prompt and shows the build steps. Once the
 * app exists `?created=<slug>` joins the URL, so a reload shows the result instead of
 * building a second app.
 */
export function NewAppWorkspace({
  prompt,
  created: initialCreated,
  onCreate,
  onDeploy,
}: {
  prompt: string;
  created: AppSummary | null;
  onCreate: (prompt: string) => Promise<ActionResult<AppSummary>>;
  onDeploy: (app: string, env: 'dev') => Promise<ActionResult<DeployResult>>;
}) {
  const { reply, steps } = buildPlan(prompt);
  const [step, setStep] = useState(initialCreated ? steps.length : 0);
  const [created, setCreated] = useState(initialCreated);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || initialCreated) return;
    started.current = true;
    const t0 = Date.now();
    void (async () => {
      const creating = onCreate(prompt);
      for (let i = 1; i < steps.length; i++) {
        await wait(STEP_MS);
        setStep(i);
      }
      const r = await creating;
      if (!r.ok) return setError(r.error);
      setCreated(r.data);
      window.history.replaceState(null, '', `/app/new/screen?${new URLSearchParams({ prompt, created: r.data.id })}`);
      const [d] = await Promise.all([onDeploy(r.data.id, 'dev'), wait(STEP_MS)]);
      if (!d.ok) return setError(d.error);
      setSeconds(Math.max(1, Math.round((Date.now() - t0) / 1000)));
      setStep(steps.length);
    })();
  }, [initialCreated, onCreate, onDeploy, prompt]);

  const done = step >= steps.length && created !== null;
  const messages: ChatMessage[] = [
    { id: 'prompt', role: 'user', author: null, parts: [{ kind: 'text', text: prompt }] },
    {
      id: 'reply',
      role: 'agent',
      author: 'Builder',
      parts: [
        { kind: 'text', text: reply },
        done
          ? { kind: 'text', text: 'Done — open it to look around. When you’re happy, **Deploy** gives you a link to share.' }
          : error
            ? { kind: 'text', text: `That didn’t work: ${error}` }
            : { kind: 'step', text: steps[Math.min(step, steps.length - 1)] ?? '', done: false },
      ],
    },
  ];

  return (
    <BuildStage
      app={created}
      done={done}
      error={error}
      detail={done ? (seconds ? `Built in ${seconds} seconds from one paragraph.` : 'Built from one paragraph.') : 'Planning data, wiring actions and generating the first screen.'}
      steps={steps.map((text, i) => ({ key: text, text, state: i < step || done ? 'done' : i === step && !error ? 'running' : 'waiting' }))}
      messages={messages}
    />
  );
}

interface Started {
  app: AppSummary;
  turn: string | null;
}

/**
 * The same page on a real Builder: the app is created and built by its workspace, and every step
 * shown here is one the workspace reported. `session` is set after a reload, when the app exists.
 */
export function LiveNewAppWorkspace({ prompt, created, session }: { prompt: string; created: AppSummary | null; session: BuilderSession | null }) {
  const [started, setStarted] = useState<Started | null>(created ? { app: created, turn: null } : null);
  const [failure, setFailure] = useState<string | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current || created) return;
    requested.current = true;
    void (async () => {
      try {
        const res = await fetch('/api/builder/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
        const body = (await res.json().catch(() => null)) as { app?: AppSummary; turn?: string; error?: { message?: string } } | null;
        if (body?.app) {
          setStarted({ app: body.app, turn: body.turn ?? null });
          window.history.replaceState(null, '', `/app/new/screen?${new URLSearchParams({ prompt, created: body.app.id })}`);
        }
        if (!res.ok) setFailure(body?.error?.message ?? 'The Builder did not start.');
      } catch {
        setFailure('The Builder could not be reached.');
      }
    })();
  }, [created, prompt]);

  const [initial] = useState<BuilderEvent[]>(() => session?.events ?? []);
  const events = useBuilderEvents(started && !failure ? started.app.id : null, initial);
  // The build is the first turn of the workspace.
  const turn = turnsOf(events)[0] ?? null;
  const error = failure ?? (turn?.status === 'failed' ? (turn.error ?? 'The build did not finish.') : null);
  const done = turn?.status === 'succeeded';
  const seconds = turn?.finishedAt ? Math.max(1, Math.round((Date.parse(turn.finishedAt) - Date.parse(turn.startedAt)) / 1000)) : null;

  const steps: StageStep[] = turn
    ? turn.steps.map((s) => ({ key: s.key, text: s.text, state: s.status === 'done' ? 'done' : s.status === 'failed' || turn.status === 'failed' ? 'failed' : 'running' }))
    : [{ key: 'start', text: started ? 'Starting the workspace' : 'Creating the app', state: error ? 'failed' : 'running' }];

  const messages: ChatMessage[] = turn
    ? threadFromEvents(events.filter((e) => e.turn === turn.id))
    : [
        { id: 'prompt', role: 'user', author: null, parts: [{ kind: 'text', text: prompt }] },
        { id: 'reply', role: 'agent', author: 'Builder', parts: [error ? { kind: 'text', text: `That didn’t work: ${error}` } : { kind: 'step', text: 'Starting the workspace', done: false }] },
      ];

  return (
    <BuildStage
      app={started?.app ?? null}
      done={done}
      error={error}
      detail={done ? (seconds ? `Built in ${seconds} seconds from one paragraph.` : 'Built from one paragraph.') : 'The Builder is writing the data, the access rules and the first screen.'}
      note={
        !turn
          ? null
          : turn.agent.kind === 'scripted'
            ? 'Built by the scripted demo agent: no model key is configured, so it makes the Ticket Board app whatever the prompt says.'
            : `Built by ${agentLabel(turn.agent)}.`
      }
      steps={steps}
      messages={messages}
    />
  );
}
