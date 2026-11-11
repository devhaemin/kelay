import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/api/types';
import type { BuilderEvent, BuilderSession } from '@/lib/builder';
import { ChatPanel } from './chat-panel';

const thread: ChatMessage[] = [
  { id: 'm1', role: 'user', author: null, parts: [{ kind: 'text', text: 'Members should only see their own tickets' }] },
  { id: 'm2', role: 'agent', author: 'Builder', parts: [{ kind: 'step', text: 'Added rule', done: true }, { kind: 'text', text: 'Use **Preview as** to check.' }] },
];

describe('Builder chat panel', () => {
  it('renders steps and inline emphasis from the thread', () => {
    render(<ChatPanel appName="Ticket Board" context="Access · tickets" messages={thread} />);
    expect(screen.getByText('Added rule')).toBeInTheDocument();
    expect(screen.getByText('Preview as').tagName).toBe('B');
    expect(screen.getByLabelText('Message the Builder agent')).toBeDisabled();
  });

  it('sends a message and shows the returned thread', async () => {
    const reply: ChatMessage = { id: 'm4', role: 'agent', author: 'Builder', parts: [{ kind: 'text', text: 'On it.' }] };
    const onSend = vi.fn(async (text: string) => ({
      ok: true as const,
      data: [...thread, { id: 'm3', role: 'user' as const, author: null, parts: [{ kind: 'text' as const, text }] }, reply],
    }));
    render(<ChatPanel appName="Ticket Board" context="Screen · Board" messages={thread} onSend={onSend} />);

    const box = screen.getByLabelText('Message the Builder agent');
    await userEvent.type(box, 'Open the board on My tickets{Enter}');

    expect(onSend).toHaveBeenCalledWith('Open the board on My tickets');
    expect(await screen.findByText('On it.')).toBeInTheDocument();
    expect(box).toHaveValue('');
  });
});

/** Stands in for the browser's EventSource: the test pushes events through `emit`. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  private readonly listeners = new Map<string, ((message: MessageEvent<string>) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(event: BuilderEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener({ data: JSON.stringify(event) } as MessageEvent<string>);
  }
  close() {
    this.closed = true;
  }
}

describe('Builder chat panel on a workspace', () => {
  afterEach(() => vi.unstubAllGlobals());

  const agent = { kind: 'scripted' as const, model: null };
  const at = '2026-11-12T00:00:00.000Z';
  const base = { at, app: 'team-board' };
  const history: BuilderEvent[] = [
    { ...base, id: 1, turn: 't1', type: 'turn.started', kind: 'build', prompt: 'A ticket board', context: null, agent },
    { ...base, id: 2, turn: 't1', type: 'assistant.text', text: 'I built a **Ticket Board**.' },
    { ...base, id: 3, turn: 't1', type: 'turn.finished', status: 'succeeded', error: null },
  ];
  const session: BuilderSession = { workspace: { app: 'team-board', state: 'idle', agent, previewUrl: null, version: 'v1', lastEventId: 3 }, events: history };

  it('shows the transcript, says the agent is the scripted demo, and follows the event stream', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ turn: 't2' }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ChatPanel appName="Team Board" context="Screen · Board" messages={[]} session={session} />);

    expect(screen.getByText('Ticket Board').tagName).toBe('B');
    expect(screen.getByRole('note')).toHaveTextContent('Scripted demo agent');
    expect(FakeEventSource.last?.url).toBe('/api/builder/workspaces/team-board/events?after=3');

    const box = screen.getByLabelText('Message the Builder agent');
    await userEvent.type(box, 'Add a priority{Enter}');
    expect(fetchMock).toHaveBeenCalledWith('/api/builder/workspaces/team-board/messages', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Add a priority', context: 'Screen · Board' }) }));
    expect(box).toHaveValue('');

    const source = FakeEventSource.last!;
    act(() => {
      source.emit({ ...base, id: 4, turn: 't2', type: 'turn.started', kind: 'message', prompt: 'Add a priority', context: 'Screen · Board', agent });
      source.emit({ ...base, id: 5, turn: 't2', type: 'step', key: 'agent-1', text: 'Added a priority field to tickets', status: 'running' });
    });
    expect(screen.getByText('Add a priority')).toBeInTheDocument();
    expect(screen.getByText('Added a priority field to tickets…')).toBeInTheDocument();
    // One turn at a time: the composer waits for this one.
    await userEvent.type(box, 'and labels');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    act(() => {
      source.emit({ ...base, id: 5, turn: 't2', type: 'step', key: 'agent-1', text: 'Added a priority field to tickets', status: 'running' });
      source.emit({ ...base, id: 6, turn: 't2', type: 'step', key: 'agent-1', text: 'Added a priority field to tickets', status: 'done' });
      source.emit({ ...base, id: 7, turn: 't2', type: 'assistant.text', text: 'Tickets now have a priority.' });
      source.emit({ ...base, id: 8, turn: 't2', type: 'turn.finished', status: 'succeeded', error: null });
    });
    expect(screen.getByText('Tickets now have a priority.')).toBeInTheDocument();
    expect(screen.getAllByText('Added a priority field to tickets')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('shows why the Builder refused a message', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'conflict', message: 'The Builder is still working on the last request.' } }), { status: 409 })));
    render(<ChatPanel appName="Team Board" context="Screen · Board" messages={[]} session={session} />);
    const box = screen.getByLabelText('Message the Builder agent');
    await userEvent.type(box, 'Again{Enter}');
    expect(box).toHaveValue('Again');
  });
});
