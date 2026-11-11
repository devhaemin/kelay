'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { DEFAULT_PROMPT } from '@/lib/build';
import { Icon } from '../ui';

const SUGGESTIONS = [
  { label: '🎫 Jira-style ticket board', prompt: DEFAULT_PROMPT },
  { label: '📚 Team wiki', prompt: 'A Notion-style team wiki with pages, weekly notes and mentions' },
  { label: '📄 Office docs', prompt: 'An office docs app to write, review and share documents' },
  { label: '🎯 Lead qualifier', prompt: 'An agent that qualifies inbound leads and books calls' },
];

export function PromptForm() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    router.push(`/app/new/screen?prompt=${encodeURIComponent(v)}`);
  }

  return (
    <>
      <form className="prompt" ref={form} onSubmit={submit}>
        <label htmlFor="prompt" className="sr-only">Describe the app to build</label>
        <textarea
          id="prompt"
          ref={input}
          rows={2}
          placeholder="Ask Kelay to build an app that…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              form.current?.requestSubmit();
            }
          }}
        />
        <div className="prompt-row">
          <button type="button" className="round" title="Attach" aria-label="Attach a file"><Icon name="plus" /></button>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn ghost sm" style={{ color: 'var(--muted)' }}>Build <Icon name="chev" size={14} /></button>
          <button type="button" className="round" style={{ border: 'none' }} aria-label="Dictate"><Icon name="mic" /></button>
          <button type="submit" className="send" disabled={!value.trim()} aria-label="Build this app"><Icon name="up" /></button>
        </div>
      </form>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => {
              setValue(s.prompt);
              input.current?.focus();
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </>
  );
}
