'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import type { ActionResult } from '@/lib/action-result';
import type { ChatMessage } from '@/lib/api/types';
import { agentLabel, threadFromEvents, turnsOf, type BuilderEvent, type BuilderSession } from '@/lib/builder';
import { useBuilderEvents } from '@/lib/use-builder-events';
import { useServerState } from '@/lib/use-server-state';
import { useToast } from '../toast';
import { Icon, RichText } from '../ui';

export function ChatMessages({ messages }: { messages: ChatMessage[] }) {
  return (
    <>
      {messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className="msg user">
            {m.parts.map((p) => p.text).join('\n')}
          </div>
        ) : (
          <div key={m.id} className="msg agent">
            <div className="who">
              <span className="agent-badge" style={{ width: 18, height: 18, borderRadius: 5 }} aria-hidden="true" /> {m.author ?? 'Builder'}
            </div>
            {m.parts.map((p, i) =>
              p.kind === 'text' ? (
                <div key={i}><RichText text={p.text} /></div>
              ) : p.done ? (
                <div key={i} className="step done"><Icon name="check" size={14} /> {p.text}</div>
              ) : (
                <div key={i} className="step"><span className="spinner" aria-hidden="true" /> {p.text}…</div>
              ),
            )}
          </div>
        ),
      )}
    </>
  );
}

const NO_EVENTS: BuilderEvent[] = [];

/** Sends a chat message to the app's Builder workspace through the console's proxy route. */
async function postMessage(app: string, text: string, context: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/builder/workspaces/${encodeURIComponent(app)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, context }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return body?.error?.message ?? 'The Builder did not take that message.';
  } catch {
    return 'The Builder could not be reached.';
  }
}

export function ChatPanel({
  appName,
  context,
  messages: initial,
  onSend,
  session,
}: {
  appName: string;
  context: string;
  messages: ChatMessage[];
  /** Absent while there is no app to talk about yet (the first build). */
  onSend?: ((text: string) => Promise<ActionResult<ChatMessage[]>>) | undefined;
  /** The app's Builder workspace. With it the panel follows the workspace's event stream instead of `messages`. */
  session?: BuilderSession | null | undefined;
}) {
  const toast = useToast();
  const router = useRouter();
  const [fetched, setMessages] = useServerState(initial);
  const [draft, setDraft] = useState('');
  const [sending, startTransition] = useTransition();
  const form = useRef<HTMLFormElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const events = useBuilderEvents(session ? session.workspace.app : null, session?.events ?? NO_EVENTS);
  const turns = session ? turnsOf(events) : [];
  const working = turns.at(-1)?.status === 'running';
  const messages = session ? threadFromEvents(events) : fetched;
  const canSend = session ? !working : !!onSend;

  // A finished turn changed the app: the preview, the version and the tabs behind the chat are stale.
  const finished = turns.filter((t) => t.status !== 'running').length;
  const settled = useRef(finished);
  useEffect(() => {
    if (finished > settled.current) router.refresh();
    settled.current = finished;
  }, [finished, router]);

  useEffect(() => {
    if (session) end.current?.scrollIntoView?.({ block: 'end' });
  }, [session, events.length]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !canSend) return;
    startTransition(async () => {
      if (session) {
        const failed = await postMessage(session.workspace.app, text, context);
        if (failed) return toast(failed);
      } else {
        const r = await onSend!(text);
        if (!r.ok) return toast(r.error);
        setMessages(r.data);
      }
      setDraft('');
    });
  }

  return (
    <aside className="chat" aria-label="Builder agent">
      <div className="chat-head">
        <b>Agent</b>
        <span className="pill">{appName}</span>
        <span className="spacer" />
        <button type="button" className="btn sm ghost" aria-label="New conversation"><Icon name="plus" size={14} /></button>
        <button type="button" className="btn sm ghost" aria-label="More options"><Icon name="dots" size={14} /></button>
      </div>
      <div className="chat-sub"><Icon name="lock" size={12} /> Only you can see this conversation</div>
      {session?.workspace.agent.kind === 'scripted' && (
        <div className="chat-sub" role="note">
          <Icon name="flask" size={12} /> Scripted demo agent: no model key is configured, so it builds the Ticket Board and one follow-up.
        </div>
      )}
      <div className="msgs" aria-live="polite">
        <ChatMessages messages={messages} />
        <div ref={end} />
      </div>
      <form className="composer" ref={form} onSubmit={submit}>
        <span className="context-chip"><Icon name="monitor" size={12} /> {context}</span>
        <label htmlFor="builder-message" className="sr-only">Message the Builder agent</label>
        <textarea
          id="builder-message"
          placeholder="Ask for a change…"
          value={draft}
          disabled={!session && !onSend}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              form.current?.requestSubmit();
            }
          }}
        />
        <div className="composer-row">
          <button type="button" className="btn sm ghost" aria-label="Attach"><Icon name="plus" size={14} /></button>
          <span className="model">{session ? agentLabel(session.workspace.agent) : 'Auto'} <Icon name="chev" size={12} /></span>
          <span className="spacer" />
          <button type="submit" className="send" style={{ width: 30, height: 30 }} disabled={!canSend || sending || !draft.trim()} aria-label="Send">
            <Icon name="up" size={14} />
          </button>
        </div>
      </form>
    </aside>
  );
}
