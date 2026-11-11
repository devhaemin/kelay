import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/api/types';
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
