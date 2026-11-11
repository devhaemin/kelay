'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '@/lib/action-result';
import type { AppSummary, ChatMessage, DeployResult } from '@/lib/api/types';
import { BUILD_STEPS } from '@/lib/build';
import { Icon } from '../../ui';
import { ChatPanel } from '../chat-panel';
import { WorkspaceShell } from '../workspace-shell';

const STEP_MS = 800;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `/app/new/screen`: creates the app from the Home prompt and shows the build steps. Once the
 * app exists the URL switches to `?created=<slug>`, so a reload shows the result instead of
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
  const [step, setStep] = useState(initialCreated ? BUILD_STEPS.length : 0);
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
      for (let i = 1; i < BUILD_STEPS.length; i++) {
        await wait(STEP_MS);
        setStep(i);
      }
      const r = await creating;
      if (!r.ok) return setError(r.error);
      setCreated(r.data);
      window.history.replaceState(null, '', `/app/new/screen?created=${encodeURIComponent(r.data.id)}`);
      const [d] = await Promise.all([onDeploy(r.data.id, 'dev'), wait(STEP_MS)]);
      if (!d.ok) return setError(d.error);
      setSeconds(Math.max(1, Math.round((Date.now() - t0) / 1000)));
      setStep(BUILD_STEPS.length);
    })();
  }, [initialCreated, onCreate, onDeploy, prompt]);

  const ready = step >= BUILD_STEPS.length ? created : null;
  const done = ready !== null;
  const messages: ChatMessage[] = [
    { id: 'prompt', role: 'user', author: null, parts: [{ kind: 'text', text: prompt }] },
    {
      id: 'reply',
      role: 'agent',
      author: 'Builder',
      parts: [
        { kind: 'text', text: 'On it. I’ll make a board with four columns, tickets with assignees and comments, and drag to move.' },
        done
          ? { kind: 'text', text: 'Done — open it to look around. When you’re happy, **Deploy** gives you a link to share.' }
          : error
            ? { kind: 'text', text: `That didn’t work: ${error}` }
            : { kind: 'step', text: BUILD_STEPS[Math.min(step, BUILD_STEPS.length - 1)] ?? '', done: false },
      ],
    },
  ];

  return (
    <WorkspaceShell
      app={{
        id: ready ? ready.id : 'new',
        name: ready ? ready.name : 'Untitled app',
        emoji: ready ? ready.emoji : '✨',
        color: '#eef1ff',
        status: 'draft',
        detail: null,
      }}
      tab="screen"
      pendingProposals={0}
      tabsDisabled={!done}
      chat={<ChatPanel appName={ready ? ready.name : 'Untitled app'} context="Screen · Board" messages={messages} />}
    >
      <div className="stage" style={{ height: '100%', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', width: 380, maxWidth: '100%' }} aria-live="polite">
          <div className="agent-badge" style={{ width: 56, height: 56, margin: '0 auto 16px', borderRadius: 16 }} aria-hidden="true">
            <Icon name={done ? 'check' : 'sparkle'} size={24} />
          </div>
          <h2 style={{ margin: '0 0 6px', fontSize: 17 }}>{error ? 'The build stopped' : ready ? `${ready.name} is ready` : 'Building your app…'}</h2>
          <p className="muted" style={{ margin: '0 0 20px', lineHeight: 1.5 }}>
            {error ?? (done ? (seconds ? `Built in ${seconds} seconds from one paragraph.` : 'Built from one paragraph.') : 'Planning data, wiring actions and generating the first screen.')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left' }}>
            {BUILD_STEPS.map((t, i) =>
              i < step || done ? (
                <div key={t} className="step done"><Icon name="check" size={14} /> {t}</div>
              ) : i === step && !error ? (
                <div key={t} className="step"><span className="spinner" aria-hidden="true" /> {t}</div>
              ) : (
                <div key={t} className="step" style={{ opacity: 0.5 }}><Icon name="chev" size={14} /> {t}</div>
              ),
            )}
          </div>
          {ready && (
            <Link className="btn primary" style={{ marginTop: 20 }} href={`/app/${ready.id}/screen`}>
              Open {ready.name} <Icon name="arrow" size={14} />
            </Link>
          )}
          {error && <Link className="btn" style={{ marginTop: 20 }} href="/">Back to Home</Link>}
        </div>
      </div>
    </WorkspaceShell>
  );
}
