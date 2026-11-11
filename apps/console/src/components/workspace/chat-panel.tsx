'use client';

import { useRef, useState, useTransition, type FormEvent } from 'react';
import type { ActionResult } from '@/lib/action-result';
import type { ChatMessage } from '@/lib/api/types';
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

export function ChatPanel({
  appName,
  context,
  messages: initial,
  onSend,
}: {
  appName: string;
  context: string;
  messages: ChatMessage[];
  /** Absent while there is no app to talk about yet (the first build). */
  onSend?: ((text: string) => Promise<ActionResult<ChatMessage[]>>) | undefined;
}) {
  const toast = useToast();
  const [messages, setMessages] = useServerState(initial);
  const [draft, setDraft] = useState('');
  const [sending, startTransition] = useTransition();
  const form = useRef<HTMLFormElement>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !onSend) return;
    startTransition(async () => {
      const r = await onSend(text);
      if (!r.ok) return toast(r.error);
      setMessages(r.data);
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
      <div className="msgs" aria-live="polite">
        <ChatMessages messages={messages} />
      </div>
      <form className="composer" ref={form} onSubmit={submit}>
        <span className="context-chip"><Icon name="monitor" size={12} /> {context}</span>
        <label htmlFor="builder-message" className="sr-only">Message the Builder agent</label>
        <textarea
          id="builder-message"
          placeholder="Ask for a change…"
          value={draft}
          disabled={!onSend}
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
          <span className="model">Auto <Icon name="chev" size={12} /></span>
          <span className="spacer" />
          <button type="submit" className="send" style={{ width: 30, height: 30 }} disabled={!onSend || sending || !draft.trim()} aria-label="Send">
            <Icon name="up" size={14} />
          </button>
        </div>
      </form>
    </aside>
  );
}
