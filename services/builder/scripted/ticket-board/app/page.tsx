'use client';

import { useState, type FormEvent } from 'react';
import { useCollection, useMutation } from '@kelay/sdk/react';

const COLUMNS = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'In progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
] as const;

type Status = (typeof COLUMNS)[number]['key'];

export default function Board() {
  const tickets = useCollection('tickets', { orderBy: [{ field: 'created_at', dir: 'asc' }] });
  const create = useMutation((kelay, title: string) => kelay.collection('tickets').create({ title, status: 'todo' }), { invalidates: ['tickets'] });
  const move = useMutation((kelay, id: string, status: Status) => kelay.collection('tickets').update(id, { status }), { invalidates: ['tickets'] });
  const [title, setTitle] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const result = await create.mutate(title.trim());
    if (result.status === 'ok') setTitle('');
    setNotice(result.status === 'denied' ? 'Your role can’t create tickets.' : result.status === 'error' ? `That didn’t save: ${result.error.message}` : null);
  }

  // The board only shows what the server confirmed, so a refused move leaves the ticket where it was.
  async function moveTo(id: string, status: Status) {
    const result = await move.mutate(id, status);
    setNotice(result.status === 'denied' ? 'You can’t move that ticket.' : result.status === 'error' ? `That didn’t save: ${result.error.message}` : null);
  }

  const selected = tickets.rows.find((t) => t.id === open) ?? null;

  return (
    <main className="board-page">
      <header className="board-head">
        <h1>Ticket Board</h1>
        <form className="row" onSubmit={add}>
          <label htmlFor="new-ticket" className="sr-only">New ticket</label>
          <input id="new-ticket" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New ticket" />
          <button type="submit" disabled={create.pending || !title.trim()}>Add ticket</button>
        </form>
      </header>

      {notice && <p className="notice" role="status">{notice}</p>}
      {tickets.error?.code === 'unauthenticated' ? (
        <p className="notice">The board shows once you are signed in. <a href="/api/kelay/signin">Sign in with Kelay ID</a></p>
      ) : (
        tickets.error && <p className="notice">{tickets.denied ? 'Your role can’t see tickets.' : tickets.error.message}</p>
      )}

      <div className="board">
        {COLUMNS.map((column) => {
          const list = tickets.rows.filter((t) => t.status === column.key);
          return (
            <section
              key={column.key}
              className="column"
              aria-label={column.label}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging) void moveTo(dragging, column.key);
                setDragging(null);
              }}
            >
              <h2>{column.label} <span className="count">{list.length}</span></h2>
              {tickets.loading && <p className="muted">Loading…</p>}
              {list.map((t) => (
                <article key={t.id} className="ticket" draggable onDragStart={() => setDragging(t.id)} onDragEnd={() => setDragging(null)}>
                  <button type="button" className="ticket-title" onClick={() => setOpen(open === t.id ? null : t.id)}>{t.title}</button>
                  <label className="sr-only" htmlFor={`move-${t.id}`}>Move {t.title}</label>
                  <select id={`move-${t.id}`} value={column.key} onChange={(e) => void moveTo(t.id, e.target.value as Status)}>
                    {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </article>
              ))}
            </section>
          );
        })}
      </div>

      {selected && <Comments ticketId={selected.id} title={selected.title} />}
    </main>
  );
}

function Comments({ ticketId, title }: { ticketId: string; title: string }) {
  const comments = useCollection('comments', { where: { ticket_id: ticketId }, orderBy: [{ field: 'created_at', dir: 'asc' }] });
  const add = useMutation((kelay, body: string) => kelay.collection('comments').create({ ticket_id: ticketId, body }), { invalidates: ['comments'] });
  const [body, setBody] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    const result = await add.mutate(body.trim());
    if (result.status === 'ok') setBody('');
  }

  return (
    <section className="comments" aria-label={`Comments on ${title}`}>
      <h2>{title}</h2>
      {comments.error ? (
        <p className="notice">{comments.denied ? 'Your role can’t see comments.' : comments.error.message}</p>
      ) : comments.rows.length === 0 && !comments.loading ? (
        <p className="muted">No comments yet.</p>
      ) : (
        <ul className="list">
          {comments.rows.map((c) => <li key={c.id}>{c.body}</li>)}
        </ul>
      )}
      <form className="row" onSubmit={submit}>
        <label htmlFor="new-comment" className="sr-only">Comment</label>
        <input id="new-comment" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment" />
        <button type="submit" disabled={add.pending || !body.trim()}>Comment</button>
      </form>
      {add.denied && <p className="notice">Your role can’t comment.</p>}
    </section>
  );
}
