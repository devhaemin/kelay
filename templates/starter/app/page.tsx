'use client';

import { useState, type FormEvent } from 'react';
import { useCollection, useMutation } from '@kelay/sdk/react';

export default function Home() {
  const notes = useCollection('notes', { orderBy: [{ field: 'created_at', dir: 'desc' }] });
  const add = useMutation((kelay, title: string) => kelay.collection('notes').create({ title }), { invalidates: ['notes'] });
  const [title, setTitle] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const result = await add.mutate(title.trim());
    if (result.status === 'ok') setTitle('');
  }

  return (
    <main className="page">
      <h1>Notes</h1>
      <form className="row" onSubmit={submit}>
        <label htmlFor="title" className="sr-only">New note</label>
        <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Write a note" />
        <button type="submit" disabled={add.pending || !title.trim()}>Add</button>
      </form>
      {add.denied && <p className="notice">Your role can’t add notes.</p>}
      {add.error && !add.denied && <p className="notice">That didn’t save: {add.error.message}</p>}

      {notes.loading ? (
        <p className="muted">Loading…</p>
      ) : notes.error ? (
        <p className="notice">{notes.denied ? 'Your role can’t see notes.' : notes.error.message}</p>
      ) : notes.rows.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        <ul className="list">
          {notes.rows.map((n) => (
            <li key={n.id}>{n.title}</li>
          ))}
        </ul>
      )}
    </main>
  );
}
