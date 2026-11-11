import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi, createMockState } from '@/lib/api/mock';
import type { Grant } from '@/lib/api/types';
import { ToastProvider } from '../toast';
import { GraphView, type GraphViewProps } from './graph-view';

async function setup(overrides: Partial<GraphViewProps> = {}) {
  const api = createMockApi(createMockState(Date.parse('2026-11-11T03:00:00Z')));
  const [apps, grants, consents, overview] = await Promise.all([api.listApps(), api.listGrants(), api.listConsents(), api.getGraphOverview()]);
  const ok = (g: Grant | undefined, patch: Partial<Grant>) => ({ ok: true as const, data: { ...g!, ...patch } });
  const props: GraphViewProps = {
    apps,
    grants,
    consents,
    overview,
    focus: null,
    onAllow: vi.fn(async (id: string) => ok(grants.find((g) => g.id === id), { status: 'connected' })),
    onReject: vi.fn(async (id: string) => ok(grants.find((g) => g.id === id), { status: 'rejected' })),
    onRequest: vi.fn(),
    ...overrides,
  };
  render(<ToastProvider><GraphView {...props} /></ToastProvider>);
  return props;
}

describe('App Graph', () => {
  it('allows a pending connection request from the banner', async () => {
    const props = await setup();
    const banner = screen.getByRole('region', { name: 'Connection request from Ticket Board' });
    expect(within(banner).getByText(/write finished tickets into weekly notes/)).toBeInTheDocument();

    await userEvent.click(within(banner).getByRole('button', { name: 'Allow' }));

    expect(props.onAllow).toHaveBeenCalledWith('l3');
    expect(screen.queryByRole('region', { name: /Connection request/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Ticket Board can now call Team Wiki');
    expect(screen.getByRole('heading', { name: 'Connection' })).toBeInTheDocument();
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0);
  });

  it('removes a rejected request from the graph', async () => {
    const props = await setup();
    await userEvent.click(within(screen.getByRole('region', { name: /Connection request/ })).getByRole('button', { name: 'Reject' }));
    expect(props.onReject).toHaveBeenCalledWith('l3');
    expect(screen.queryByRole('button', { name: /Ticket Board to Team Wiki/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Connection request rejected');
  });

  it('keeps the request when the server refuses', async () => {
    await setup({ onAllow: vi.fn(async () => ({ ok: false as const, error: 'Only the builder can allow this' })) });
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Only the builder can allow this');
    expect(screen.getByRole('region', { name: /Connection request/ })).toBeInTheDocument();
  });

  it('traces an app: shows its endpoint and connections', async () => {
    await setup({ focus: 'docs' });
    expect(screen.getByRole('heading', { name: 'Docs' })).toBeInTheDocument();
    expect(screen.getByText('https://kelay.app/jeongyun/docs/mcp')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /← Ticket Board/ })).toBeInTheDocument();
  });
});
